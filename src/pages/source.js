'use strict'
// Seitenquelltext (caravel://source/?url=…): view-source: funktioniert in Electron-Webviews nicht,
// daher lädt der Hauptprozess den Quelltext mit den Cookies des Tabs und diese Seite zeigt ihn an.
const I18N = window.CaravelI18n
I18N.setLang(window.caravelNTP?.lang)
const T = I18N.t
I18N.translateDom(document.body)

const target = new URLSearchParams(location.search).get('url') || ''
document.getElementById('url').textContent = target
document.title = `${T('Seitenquelltext')} – ${target}`

const wrap = document.getElementById('wrap')
wrap.addEventListener('change', () => document.body.classList.toggle('wrap', wrap.checked))

;(async () => {
  const body = document.getElementById('code')
  let text
  try { text = await window.caravelNTP.source(target) } catch (err) { text = null }
  if (text == null) {
    body.innerHTML = `<tr><td class="err"></td></tr>`
    body.querySelector('.err').textContent = T('Der Quelltext konnte nicht geladen werden.')
    return
  }
  const frag = document.createDocumentFragment()
  text.split(/\r?\n/).forEach((line, i) => {
    const tr = document.createElement('tr')
    const n = document.createElement('td'); n.className = 'n'; n.textContent = i + 1
    const c = document.createElement('td'); c.className = 'c'; c.textContent = line
    tr.append(n, c)
    frag.append(tr)
  })
  body.append(frag)
})()
