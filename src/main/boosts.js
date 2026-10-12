// Boosts: eigene Anpassungen pro Website – ausgeblendete Elemente, eigenes CSS und JavaScript.
// Gespeichert in store.boosts[host] = { hide: [Selektoren], css, js, off }. Angewendet bei jedem
// Seitenaufbau (dom-ready) in Tabs; „Element ausblenden“ wählt ein Element per Pipette aus.

// Im Seitenkontext: Element per Mausklick wählen, eindeutigen CSS-Selektor zurückgeben (oder null bei Esc)
const PICKER_JS = `new Promise(resolve => {
  const HINT = __HINT__;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #f2545b;background:rgba(242,84,91,.14);border-radius:3px;transition:all .06s;display:none';
  const bar = document.createElement('div');
  bar.textContent = HINT;
  bar.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);font:600 13px/1 "Segoe UI",system-ui,sans-serif;color:#fff;background:#1d1d1f;padding:10px 14px;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.35);pointer-events:none';
  document.documentElement.append(box, bar);
  let target = null;
  const esc = s => CSS.escape(s);
  const stable = c => c && !/\\d{3,}|^(is|has)-|active|hover|focus|selected|open|visible|hidden/.test(c) && c.length < 40;
  const part = el => {
    if (el.id && !/\\d{3,}/.test(el.id) && document.querySelectorAll('#' + esc(el.id)).length === 1) return '#' + esc(el.id);
    let s = el.tagName.toLowerCase();
    const cls = [...el.classList].filter(stable).slice(0, 2);
    if (cls.length) s += cls.map(c => '.' + esc(c)).join('');
    const p = el.parentElement;
    if (p) {
      const same = [...p.children].filter(c => c.matches(s));
      if (same.length > 1) s += ':nth-of-type(' + ([...p.children].filter(c => c.tagName === el.tagName).indexOf(el) + 1) + ')';
    }
    return s;
  };
  const selector = el => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement && parts.length < 7; e = e.parentElement) {
      parts.unshift(part(e));
      const sel = parts.join(' > ');
      // Nur Tag-Name (ggf. mit nth-of-type) ist zu allgemein – dann mindestens eine Ebene darüber mitnehmen
      const specific = parts[0].startsWith('#') || parts.length > 1 || parts[0].includes('.');
      if (parts[0].startsWith('#') || (specific && document.querySelectorAll(sel).length === 1)) return sel;
    }
    return parts.join(' > ');
  };
  const move = e => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === box || el === bar || el === document.body || el === document.documentElement) return;
    target = el;
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const stop = e => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  const done = value => {
    removeEventListener('mousemove', move, true);
    for (const t of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) removeEventListener(t, block, true);
    removeEventListener('keydown', key, true);
    box.remove(); bar.remove();
    resolve(value);
  };
  const block = e => {
    stop(e);
    if (e.type === 'click') {
      if (!target) return done(null);
      const sel = selector(target);
      target.style.setProperty('display', 'none', 'important');
      done(sel);
    }
  };
  const key = e => { if (e.key === 'Escape') { stop(e); done(null); } };
  addEventListener('mousemove', move, true);
  for (const t of ['mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup']) addEventListener(t, block, true);
  addEventListener('keydown', key, true);
})`

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '' } }

class Boosts {
  constructor (getBoosts) {
    this.getBoosts = getBoosts
    this.cssKeys = new Map() // wcId → Schlüssel des eingefügten CSS (zum Ersetzen beim Bearbeiten)
  }

  boostFor (url) {
    if (!/^https?:/.test(url || '')) return null
    const b = this.getBoosts()[hostOf(url)]
    return b && !b.off ? b : null
  }

  static cssOf (b) {
    const hide = (b.hide || []).filter(Boolean)
    return (hide.length ? `${hide.join(',\n')} { display: none !important; }\n` : '') + (b.css || '')
  }

  track (wc) {
    wc.on('dom-ready', () => this.apply(wc, { scripts: true }))
    wc.once('destroyed', () => this.cssKeys.delete(wc.id))
  }

  // scripts: auch das JavaScript ausführen (nur beim Seitenaufbau, nicht beim erneuten Anwenden nach dem Bearbeiten)
  async apply (wc, { scripts = false } = {}) {
    if (wc.isDestroyed()) return
    const old = this.cssKeys.get(wc.id)
    if (old) { this.cssKeys.delete(wc.id); wc.removeInsertedCSS(old).catch(() => {}) }
    const b = this.boostFor(wc.getURL())
    if (!b) return
    const css = Boosts.cssOf(b)
    if (css.trim()) {
      try { this.cssKeys.set(wc.id, await wc.insertCSS(css, { cssOrigin: 'user' })) } catch {}
    }
    if (scripts && b.js?.trim()) {
      wc.executeJavaScript(`try { ${b.js}\n} catch (e) { console.error('[Caravel-Boost]', e) }`, true).catch(() => {})
    }
  }

  pick (wc, hint) {
    return wc.executeJavaScript(PICKER_JS.replace('__HINT__', JSON.stringify(hint)), true).catch(() => null)
  }
}

module.exports = { Boosts }
