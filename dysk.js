// Dostęp do folderu „SKANY MAM DOŚĆ” na dysku użytkownika. Dane nigdy nie wychodzą z komputera.
//  - serwer: strona otwarta skrótem z pulpitu (127.0.0.1) – pliki czyta i zapisuje lokalny program genetyka.pyw;
//  - folder: File System Access API (np. strona z GitHub Pages) – folder wybierany raz, uchwyt pamiętany w IndexedDB.
// Ścieżki są względne wobec „SKANY MAM DOŚĆ”, segmenty oddzielone „/”.

const PODPIS = 'genetyka-weryfikacja';

function zakoduj(sciezka) {
  return encodeURIComponent(sciezka);
}

export class DyskSerwer {
  constructor() { this.rodzaj = 'serwer'; this.nazwa = 'SKANY MAM DOŚĆ'; }

  static async wykryj() {
    if (!/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return null;
    try {
      const r = await fetch('/api/ping', { cache: 'no-store' });
      const d = await r.json();
      if (d.podpis !== PODPIS) return null;
      const dysk = new DyskSerwer();
      dysk.korzen = d.korzen;
      dysk.nazwa = (d.korzen || '').split(/[\\/]/).filter(Boolean).pop() || dysk.nazwa;
      return dysk;
    } catch {
      return null;
    }
  }

  async lista(sciezka) {
    const r = await fetch(`/api/lista?sciezka=${zakoduj(sciezka)}`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error((await r.json()).blad || `błąd ${r.status}`);
    return r.json();
  }

  async czytaj(sciezka, typ = 'tekst') {
    // brak=204: brakujący plik to nie błąd (np. genetyka_poprawki.json przy pierwszym otwarciu rocznika)
    const r = await fetch(`/api/plik?brak=204&sciezka=${zakoduj(sciezka)}`, { cache: 'no-store' });
    if (r.status === 404 || r.status === 204) return null;
    if (!r.ok) throw new Error((await r.json()).blad || `błąd ${r.status}`);
    return typ === 'binarny' ? r.arrayBuffer() : r.text();
  }

  async zapisz(sciezka, dane) {
    const r = await fetch(`/api/plik?sciezka=${zakoduj(sciezka)}`, {
      method: 'POST', headers: { 'X-Genetyka': '1', 'Content-Type': 'application/octet-stream' }, body: dane,
      keepalive: dane.byteLength < 60000,            // małe zapisy (poprawki) dochodzą też przy zamykaniu karty
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).blad || `błąd zapisu ${r.status}`);
    return r.json();
  }

  async adresObrazu(sciezka) {
    return `/api/plik?sciezka=${zakoduj(sciezka)}`;
  }

  async ping() {
    await fetch('/api/ping', { cache: 'no-store' });
  }
}

// ------------------------------------------------------------------ File System Access API

const BAZA = 'genetyka-weryfikacja';

function bazaIdb() {
  return new Promise((ok, zle) => {
    const z = indexedDB.open(BAZA, 1);
    z.onupgradeneeded = () => z.result.createObjectStore('uchwyty');
    z.onsuccess = () => ok(z.result);
    z.onerror = () => zle(z.error);
  });
}

async function idb(tryb, fn) {
  const db = await bazaIdb();
  return new Promise((ok, zle) => {
    const tx = db.transaction('uchwyty', tryb);
    const wynik = fn(tx.objectStore('uchwyty'));
    tx.oncomplete = () => ok(wynik.result);
    tx.onerror = () => zle(tx.error);
  });
}

export function folderDostepny() {
  return typeof window.showDirectoryPicker === 'function';
}

export class DyskFolder {
  constructor(uchwyt) { this.rodzaj = 'folder'; this.uchwyt = uchwyt; this.nazwa = uchwyt.name; this.obrazy = new Map(); }

  /** Zapamiętany folder (null, gdy brak). uprawnienie: 'granted' albo 'prompt' (wtedy trzeba kliknąć „Połącz”). */
  static async zapamietany() {
    if (!folderDostepny()) return null;
    try {
      const uchwyt = await idb('readonly', (s) => s.get('korzen'));
      if (!uchwyt) return null;
      const dysk = new DyskFolder(uchwyt);
      dysk.uprawnienie = await uchwyt.queryPermission({ mode: 'readwrite' });
      return dysk;
    } catch {
      return null;
    }
  }

  static async wybierz() {
    const uchwyt = await window.showDirectoryPicker({ id: 'skany', mode: 'readwrite' });
    await idb('readwrite', (s) => s.put(uchwyt, 'korzen'));
    const dysk = new DyskFolder(uchwyt);
    dysk.uprawnienie = 'granted';
    return dysk;
  }

  async polacz() {
    this.uprawnienie = await this.uchwyt.requestPermission({ mode: 'readwrite' });
    return this.uprawnienie === 'granted';
  }

  async folder(segmenty, utworz = false) {
    let h = this.uchwyt;
    for (const seg of segmenty) {
      try {
        h = await h.getDirectoryHandle(seg, { create: utworz });
      } catch (e) {
        // nazwa z innym zapisem Unicode (NFC/NFD) – szukamy po normalizacji
        let znaleziony = null;
        for await (const [n, uch] of h.entries()) {
          if (uch.kind === 'directory' && n.normalize('NFC') === seg.normalize('NFC')) { znaleziony = uch; break; }
        }
        if (!znaleziony) {
          if (e.name === 'NotFoundError' || e.name === 'TypeError') return null;
          throw e;
        }
        h = znaleziony;
      }
    }
    return h;
  }

  async plik(sciezka) {
    const seg = sciezka.split('/').filter(Boolean);
    const folder = await this.folder(seg.slice(0, -1));
    if (!folder) return null;
    const nazwa = seg[seg.length - 1];
    try {
      return await (await folder.getFileHandle(nazwa)).getFile();
    } catch {
      for await (const [n, uch] of folder.entries()) {
        if (uch.kind === 'file' && n.normalize('NFC') === nazwa.normalize('NFC')) return uch.getFile();
      }
      return null;
    }
  }

  async lista(sciezka) {
    const folder = await this.folder(sciezka.split('/').filter(Boolean));
    if (!folder) return null;
    const foldery = [], pliki = [];
    for await (const [n, uch] of folder.entries()) {
      if (n.startsWith('.')) continue;
      (uch.kind === 'directory' ? foldery : pliki).push(n);
    }
    return { foldery: foldery.sort(), pliki: pliki.sort() };
  }

  async czytaj(sciezka, typ = 'tekst') {
    const f = await this.plik(sciezka);
    if (!f) return null;
    return typ === 'binarny' ? f.arrayBuffer() : f.text();
  }

  async zapisz(sciezka, dane) {
    const seg = sciezka.split('/').filter(Boolean);
    const folder = await this.folder(seg.slice(0, -1));
    if (!folder) throw new Error('Nie ma folderu: ' + seg.slice(0, -1).join('/'));
    const uch = await folder.getFileHandle(seg[seg.length - 1], { create: true });
    const zapis = await uch.createWritable();
    await zapis.write(dane);
    await zapis.close();
    return { ok: true };
  }

  async adresObrazu(sciezka) {
    if (this.obrazy.has(sciezka)) return this.obrazy.get(sciezka);
    const f = await this.plik(sciezka);
    if (!f) return '';
    const url = URL.createObjectURL(f);
    if (this.obrazy.size > 40) {               // nie trzymamy w pamięci wszystkich obrazów
      const [k, v] = this.obrazy.entries().next().value;
      URL.revokeObjectURL(v);
      this.obrazy.delete(k);
    }
    this.obrazy.set(sciezka, url);
    return url;
  }

  async ping() {}
}

/** Zapis przez pobranie pliku (gdy nie ma ani serwera, ani dostępu do folderu). */
export function pobierzPlik(nazwa, dane, typ = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([dane], { type: typ }));
  const a = Object.assign(document.createElement('a'), { href: url, download: nazwa });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
