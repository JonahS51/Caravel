// Caravel Cloud-Sync: speichert pro Konto genau eine Datei – den bereits auf dem Gerät mit AES-256-GCM
// verschlüsselten Sync-Stand (siehe src/main/sync.js). Der Server sieht nie Klartext.
//
//   GET    /api/sync/:id   → 200 + Datei, ETag = Version   | 404, wenn es noch nichts gibt
//   PUT    /api/sync/:id   → If-Match: "<Version>" ersetzt, If-None-Match: * legt an | 412 bei Konflikt
//   DELETE /api/sync/:id   → löscht das Konto samt Daten
//
// Anmeldung: Authorization: Bearer <Token>. Gespeichert wird nur SHA-256(Token). Konto-ID und Token
// leitet Caravel aus dem Sync-Code ab, der nur auf den Geräten liegt.

const MAX_SIZE = 8 * 1024 * 1024
const CHUNK = 1000 * 1000 // D1 erlaubt höchstens 2 MB pro Zeile

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
})

async function sha256 (text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Vergleich in konstanter Zeit
function equal (a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const etag = version => `"${version}"`
const parseTag = value => {
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(String(value || '').trim())
  return m ? Number(m[1]) : null
}

export async function onRequest ({ request, params, env }) {
  const id = String(params.id || '')
  if (!/^[0-9a-f]{32}$/.test(id)) return json(400, { error: 'invalid id' })
  const token = /^Bearer ([0-9a-f]{64})$/.exec(request.headers.get('authorization') || '')?.[1]
  if (!token) return json(401, { error: 'missing token' })
  const tokenHash = await sha256(token)

  const account = await env.DB.prepare('SELECT token_hash, version FROM accounts WHERE id = ?').bind(id).first()
  if (account && !equal(account.token_hash, tokenHash)) return json(403, { error: 'forbidden' })

  switch (request.method) {
    case 'GET': {
      if (!account) return json(404, { error: 'not found' })
      const { results } = await env.DB.prepare('SELECT data FROM chunks WHERE id = ? AND version = ? ORDER BY n').bind(id, account.version).all()
      return new Response(results.map(r => r.data).join(''), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', etag: etag(account.version) }
      })
    }

    case 'PUT': {
      const length = Number(request.headers.get('content-length') || 0)
      if (length > MAX_SIZE) return json(413, { error: 'too large' })
      const body = await request.text()
      if (body.length > MAX_SIZE) return json(413, { error: 'too large' })
      try {
        if (JSON.parse(body).format !== 'caravel-sync') throw new Error()
      } catch { return json(400, { error: 'invalid body' }) }

      const create = request.headers.get('if-none-match') === '*'
      const expected = parseTag(request.headers.get('if-match'))
      if (create ? account : (!account || expected !== account.version)) {
        return json(412, { error: 'conflict' }, account ? { etag: etag(account.version) } : {})
      }

      const next = create ? 1 : account.version + 1
      const now = Date.now()
      const parts = []
      for (let i = 0; i < body.length || i === 0; i += CHUNK) parts.push(body.slice(i, i + CHUNK))
      // Neue Version erst vollständig schreiben, dann umschalten. Schreiben zwei Geräte gleichzeitig,
      // scheitert das zweite am Primärschlüssel und die ganze Transaktion wird zurückgerollt.
      const stmts = parts.map((data, n) => env.DB.prepare('INSERT INTO chunks (id, version, n, data) VALUES (?, ?, ?, ?)').bind(id, next, n, data))
      stmts.push(create
        ? env.DB.prepare('INSERT INTO accounts (id, token_hash, version, size, created, updated) VALUES (?, ?, 1, ?, ?, ?)').bind(id, tokenHash, body.length, now, now)
        : env.DB.prepare('UPDATE accounts SET version = ?, size = ?, updated = ? WHERE id = ? AND version = ?').bind(next, body.length, now, id, account.version))
      let results
      try { results = await env.DB.batch(stmts) } catch {
        return json(412, { error: 'conflict' })
      }
      if (!results.at(-1).meta.changes) {
        await env.DB.prepare('DELETE FROM chunks WHERE id = ? AND version = ?').bind(id, next).run()
        return json(412, { error: 'conflict' })
      }
      // Nur ältere Versionen löschen – ein anderes Gerät kann inzwischen schon die nächste geschrieben haben
      await env.DB.prepare('DELETE FROM chunks WHERE id = ? AND version < ?').bind(id, next).run()
      return json(200, { version: next }, { etag: etag(next) })
    }

    case 'DELETE': {
      if (!account) return new Response(null, { status: 204 })
      await env.DB.batch([
        env.DB.prepare('DELETE FROM chunks WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id)
      ])
      return new Response(null, { status: 204 })
    }

    default:
      return json(405, { error: 'method not allowed' }, { allow: 'GET, PUT, DELETE' })
  }
}
