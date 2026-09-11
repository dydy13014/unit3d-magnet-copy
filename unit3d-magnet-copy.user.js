// ==UserScript==
// @name         Tracker Magnet Auto-Copy (C411 / Tr4ker / V3X)
// @namespace    unit3d-magnet-copy
// @version      6.1
// @description  Quand tu cliques sur "Télécharger" sur C411, Tr4ker ou V3X, le script récupère le vrai .torrent (avec tracker/passkey), en extrait le magnet complet et le copie automatiquement dans le presse-papiers, SANS télécharger le fichier .torrent lui-même par défaut (plus de boîte de dialogue "Enregistrer sous" à chaque clic). Panneau flottant pour copier plusieurs magnets d'affilée (season packs), avec bouton optionnel pour envoyer un magnet à AllDebrid (jamais automatique) et bouton pour télécharger quand même le .torrent réel (utile au-delà de la limite ~100 Go d'AllDebrid, signalée dans le panneau).
// @match        *://*.c411.org/*
// @match        *://*.tr4ker.net/*
// @match        *://*.v3x.club/*
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      c411.org
// @connect      tr4ker.net
// @connect      v3x.club
// @connect      api.v3x.club
// @connect      api.alldebrid.com
// ==/UserScript==

(function () {
    'use strict';

    // Pattern observé sur les 3 sites : GET .../api/torrents/{id}/download ou .../torrents/{id}/download
    // {id} peut être un slug (Tr4ker), un infohash (C411) ou un UUID (V3X).
    const DOWNLOAD_URL_RE = /\/(?:api\/)?torrents\/[^/?#]+\/download(?:[/?#]|$)/i;
    const NETWORK_TIMEOUT_MS = 20000;
    const PARSE_TIMEOUT_MS = 5000;

    // Anti-doublon : évite de traiter deux fois la même URL si elle est à la fois
    // capturée par le patch fetch/XHR (C411, Tr4ker) et par le listener de clic
    // (filet de sécurité générique, seul chemin qui marche pour V3X : vrai <a href>,
    // donc navigation native du navigateur, jamais vue par fetch/XHR).
    const recentlyHandled = new Map();
    function shouldHandle(url) {
        const now = Date.now();
        const last = recentlyHandled.get(url);
        if (last && now - last < 5000) return false;
        recentlyHandled.set(url, now);
        return true;
    }

    // Référence au vrai .click() natif, capturée par patchAnchorClick() plus bas —
    // doit être déclarée AVANT les appels ci-dessous (sinon TDZ : ReferenceError
    // silencieux qui interrompt toute l'initialisation du script).
    let originalAnchorClick = null;

    injectPanelStyles();
    patchFetch();
    patchXHR();
    patchAnchorClick();
    watchRealLinkClicks();

    // C411/Tr4ker déclenchent la sauvegarde du .torrent en créant (souvent à la
    // volée, hors DOM) un <a download="...torrent" href="blob:..."> puis en
    // appelant .click() dessus en JS — jamais un vrai clic utilisateur, donc
    // invisible pour un listener de clic classique. On neutralise ce .click()
    // précis (le panneau propose un bouton dédié si on veut quand même le
    // fichier), sans toucher au fetch/XHR original qui sert à extraire le magnet.
    function patchAnchorClick() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const AnchorProto = win.HTMLAnchorElement && win.HTMLAnchorElement.prototype;
        if (!AnchorProto) return;
        originalAnchorClick = AnchorProto.click;
        AnchorProto.click = function () {
            const href = this.href || '';
            const isBlobDownload = href.indexOf('blob:') === 0 && this.hasAttribute('download');
            if (isBlobDownload) return; // sauvegarde .torrent avalée
            return originalAnchorClick.apply(this, arguments);
        };
    }

    // Téléchargement volontaire déclenché par le bouton ".torrent" du panneau —
    // contourne notre propre blocage ci-dessus via le vrai .click() natif.
    // Utile quand AllDebrid refuse le magnet (limite ~100 Go) : le fichier réel
    // permet un contournement (upload direct, autre debrideur, client torrent).
    function downloadBlobAsFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename || 'torrent.torrent';
        (originalAnchorClick ? originalAnchorClick : HTMLAnchorElement.prototype.click).call(a);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    function torrentFilename(entry) {
        const base = entry.name || 'torrent';
        return /\.torrent$/i.test(base) ? base : base + '.torrent';
    }

    function patchFetch() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const originalFetch = win.fetch;
        if (!originalFetch) return;

        win.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            const promise = originalFetch.apply(this, arguments);
            if (DOWNLOAD_URL_RE.test(url)) {
                promise.then(res => {
                    if (res && res.ok) handleTorrentResponse(res.clone(), url);
                }).catch(() => {});
            }
            return promise;
        };
    }

    function patchXHR() {
        const win = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const XHR = win.XMLHttpRequest;
        if (!XHR) return;

        const originalOpen = XHR.prototype.open;
        XHR.prototype.open = function (method, url) {
            this.__magnetCopyUrl = url;
            return originalOpen.apply(this, arguments);
        };

        const originalSend = XHR.prototype.send;
        XHR.prototype.send = function () {
            const url = this.__magnetCopyUrl || '';
            if (DOWNLOAD_URL_RE.test(url)) {
                this.addEventListener('load', () => {
                    if (this.status >= 200 && this.status < 300) {
                        const blob = this.response instanceof Blob
                            ? this.response
                            : new Blob([this.response]);
                        handleTorrentResponse(blob, url);
                    }
                });
            }
            return originalSend.apply(this, arguments);
        };
    }

    // V3X (et potentiellement d'autres) : le bouton "Télécharger" est un vrai <a href>
    // qui déclenche une navigation native du navigateur, jamais visible par fetch/XHR.
    // On bloque cette navigation (fichier .torrent inutile une fois le magnet extrait)
    // et on fait nous-mêmes la requête, indépendamment, pour extraire le magnet.
    function watchRealLinkClicks() {
        document.addEventListener('click', evt => {
            const link = evt.target.closest && evt.target.closest('a[href]');
            if (!link) return;
            if (!DOWNLOAD_URL_RE.test(link.href)) return;
            evt.preventDefault();
            if (!shouldHandle(link.href)) return;

            const entry = addPanelEntry(link.href);
            withTimeout(downloadTorrentViaGM(link.href), NETWORK_TIMEOUT_MS, 'Téléchargement du .torrent')
                .then(blob => finishEntry(entry, blob, link.href))
                .catch(err => failEntry(entry, err, link.href));
        }, true);
    }

    function downloadTorrentViaGM(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                onload: res => (res.status >= 200 && res.status < 300)
                    ? resolve(res.response)
                    : reject(new Error('HTTP ' + res.status + ' sur ' + url)),
                onerror: () => reject(new Error('Erreur réseau sur ' + url)),
            });
        });
    }

    function handleTorrentResponse(responseOrBlob, url) {
        if (!shouldHandle(url)) return;
        const entry = addPanelEntry(url);
        const blobPromise = responseOrBlob instanceof Blob
            ? Promise.resolve(responseOrBlob)
            : responseOrBlob.blob();
        withTimeout(blobPromise, NETWORK_TIMEOUT_MS, 'Récupération du .torrent')
            .then(blob => finishEntry(entry, blob, url))
            .catch(err => failEntry(entry, err, url));
    }

    function finishEntry(entry, blob, url) {
        entry.blob = blob; // conservé pour le bouton "DL .torrent" du panneau, sans re-fetch
        withTimeout(torrentBlobToMagnet(blob), PARSE_TIMEOUT_MS, 'Extraction du magnet')
            .then(({ magnetURI, name, size }) => {
                entry.name = name || urlBasename(url);
                entry.size = size;
                entry.magnetURI = magnetURI;
                entry.state = 'ok';
                GM_setClipboard(magnetURI, 'text');
                renderPanel();
            })
            .catch(err => failEntry(entry, err, url));
    }

    function failEntry(entry, err, url) {
        console.error('[magnet-copy]', url, err);
        entry.state = 'error';
        entry.name = entry.name || urlBasename(url);
        entry.error = err && err.message ? err.message : String(err);
        renderPanel();
    }

    function urlBasename(url) {
        try {
            const path = new URL(url).pathname.replace(/\/download\/?$/, '');
            return decodeURIComponent(path.split('/').filter(Boolean).pop() || url);
        } catch (e) {
            return url;
        }
    }

    function withTimeout(promise, ms, label) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                reject(new Error((label || 'Opération') + ' : délai dépassé (' + Math.round(ms / 1000) + 's)'));
            }, ms);
            promise.then(
                v => { clearTimeout(timer); resolve(v); },
                e => { clearTimeout(timer); reject(e); }
            );
        });
    }

    // ---------------------------------------------------------------------
    // Parsing bencode minimal (pas de dépendance externe) : décode le .torrent,
    // isole les octets bruts du dictionnaire "info" (nécessaires tels quels
    // pour le hash), calcule le SHA-1 via l'API Web Crypto native, et construit
    // le magnet (infohash + nom + trackers).
    // ---------------------------------------------------------------------
    function decodeBencodeValue(buf, ctx) {
        const c = buf[ctx.pos];
        if (c === 0x69 /* 'i' */) return decodeBencodeInt(buf, ctx);
        if (c === 0x6c /* 'l' */) return decodeBencodeList(buf, ctx);
        if (c === 0x64 /* 'd' */) return decodeBencodeDict(buf, ctx);
        if (c >= 0x30 && c <= 0x39) return decodeBencodeBytes(buf, ctx);
        throw new Error('bencode invalide à la position ' + ctx.pos);
    }

    function decodeBencodeInt(buf, ctx) {
        ctx.pos++; // 'i'
        const start = ctx.pos;
        while (ctx.pos < buf.length && buf[ctx.pos] !== 0x65) ctx.pos++;
        if (ctx.pos >= buf.length) throw new Error('bencode: entier non terminé');
        const n = parseInt(asciiSlice(buf, start, ctx.pos), 10);
        ctx.pos++; // 'e'
        return n;
    }

    function decodeBencodeBytes(buf, ctx) {
        const start = ctx.pos;
        while (ctx.pos < buf.length && buf[ctx.pos] !== 0x3a) ctx.pos++;
        if (ctx.pos >= buf.length) throw new Error('bencode: longueur de chaîne invalide');
        const len = parseInt(asciiSlice(buf, start, ctx.pos), 10);
        if (!Number.isFinite(len) || len < 0) throw new Error('bencode: longueur de chaîne invalide');
        ctx.pos++; // ':'
        const dataStart = ctx.pos;
        ctx.pos += len;
        if (ctx.pos > buf.length) throw new Error('bencode: chaîne tronquée');
        return buf.subarray(dataStart, ctx.pos);
    }

    function decodeBencodeList(buf, ctx) {
        ctx.pos++; // 'l'
        const list = [];
        while (ctx.pos < buf.length && buf[ctx.pos] !== 0x65) {
            list.push(decodeBencodeValue(buf, ctx));
        }
        if (ctx.pos >= buf.length) throw new Error('bencode: liste non terminée');
        ctx.pos++; // 'e'
        return list;
    }

    function decodeBencodeDict(buf, ctx) {
        ctx.pos++; // 'd'
        const dict = {};
        let infoRaw = null;
        while (ctx.pos < buf.length && buf[ctx.pos] !== 0x65) {
            const keyBytes = decodeBencodeBytes(buf, ctx);
            const key = utf8(keyBytes);
            if (key === 'info') {
                const infoStart = ctx.pos;
                dict[key] = decodeBencodeValue(buf, ctx);
                infoRaw = buf.subarray(infoStart, ctx.pos);
            } else {
                dict[key] = decodeBencodeValue(buf, ctx);
            }
        }
        if (ctx.pos >= buf.length) throw new Error('bencode: dictionnaire non terminé');
        ctx.pos++; // 'e'
        if (infoRaw) dict.__infoRaw = infoRaw;
        return dict;
    }

    function asciiSlice(buf, start, end) {
        let s = '';
        for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
        return s;
    }

    function utf8(bytes) {
        return new TextDecoder('utf-8').decode(bytes);
    }

    async function torrentBlobToMagnet(blob) {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const ctx = { pos: 0 };
        const torrent = decodeBencodeValue(buf, ctx);
        if (!torrent || typeof torrent !== 'object' || !torrent.info || !torrent.__infoRaw) {
            throw new Error('fichier .torrent invalide (pas de dictionnaire "info")');
        }

        const hashBuf = await crypto.subtle.digest('SHA-1', torrent.__infoRaw);
        const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');

        const trackers = [];
        const addTracker = bytes => {
            try {
                const url = utf8(bytes);
                if (url && !trackers.includes(url)) trackers.push(url);
            } catch (e) { /* tracker illisible, on l'ignore */ }
        };
        if (torrent.announce) addTracker(torrent.announce);
        if (Array.isArray(torrent['announce-list'])) {
            for (const tier of torrent['announce-list']) {
                if (Array.isArray(tier)) tier.forEach(addTracker);
            }
        }

        const name = torrent.info.name ? utf8(torrent.info.name) : '';
        let size = 0;
        if (typeof torrent.info.length === 'number') {
            size = torrent.info.length;
        } else if (Array.isArray(torrent.info.files)) {
            size = torrent.info.files.reduce((sum, f) => sum + (typeof f.length === 'number' ? f.length : 0), 0);
        }

        const params = ['xt=urn:btih:' + hashHex];
        if (name) params.push('dn=' + encodeURIComponent(name));
        trackers.forEach(t => params.push('tr=' + encodeURIComponent(t)));

        return { magnetURI: 'magnet:?' + params.join('&'), name, size };
    }

    // AllDebrid refuse les magnets au-delà d'environ 100 Go — au-delà de ce
    // seuil, mieux vaut passer par le fichier .torrent réel (autre debrideur,
    // upload direct, client torrent) plutôt que par le magnet.
    const ALLDEBRID_SIZE_LIMIT_BYTES = 100 * 1024 ** 3;

    function formatSize(bytes) {
        if (!bytes) return '';
        const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
        let i = 0, v = bytes;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        const text = v.toFixed(v < 10 ? 2 : 1) + ' ' + units[i];
        return bytes >= ALLDEBRID_SIZE_LIMIT_BYTES ? '⚠️ ' + text + ' — au-delà de la limite AllDebrid' : text;
    }

    // ---------------------------------------------------------------------
    // Panneau flottant : accumule les magnets extraits (utile pour les season
    // packs où on enchaîne plusieurs clics "Télécharger" d'affilée). Le
    // dernier magnet extrait reste copié automatiquement dans le presse-
    // papiers (comportement simple inchangé pour un téléchargement isolé) ;
    // "Copier tout" permet de récupérer la liste complète d'un coup.
    // ---------------------------------------------------------------------
    let panelEntries = [];
    let entrySeq = 0;

    function addPanelEntry(url) {
        const entry = { id: ++entrySeq, url, name: urlBasename(url), size: 0, magnetURI: null, state: 'busy', error: null };
        panelEntries.push(entry);
        renderPanel();
        return entry;
    }

    function injectPanelStyles() {
        const css = `
          #magnet-copy-panel {
            position:fixed; right:16px; bottom:16px; z-index:2147483647;
            width:320px; max-height:380px; display:flex; flex-direction:column;
            background:#1e1e1e; color:#fff; border:1px solid #444; border-radius:10px;
            font:13px/1.4 -apple-system,sans-serif; box-shadow:0 4px 14px rgba(0,0,0,.45);
          }
          #magnet-copy-panel[hidden] { display:none; }
          #magnet-copy-panel .mcp-header {
            display:flex; justify-content:space-between; align-items:center;
            padding:8px 10px; border-bottom:1px solid #333; font-weight:bold; flex:none;
          }
          #magnet-copy-panel .mcp-header button {
            background:none; border:none; color:#aaa; cursor:pointer; font-size:16px; line-height:1; padding:0 2px;
          }
          #magnet-copy-panel .mcp-header button:hover { color:#fff; }
          #magnet-copy-panel .mcp-list { overflow-y:auto; flex:1; }
          #magnet-copy-panel .mcp-item {
            display:flex; align-items:center; gap:6px; padding:6px 10px; flex-wrap:wrap;
            border-bottom:1px solid #2a2a2a; transition:background .3s;
          }
          #magnet-copy-panel .mcp-header-btns { display:flex; gap:6px; }
          #magnet-copy-panel .mcp-item.flash { background:#1c3b26; }
          #magnet-copy-panel .mcp-item:last-child { border-bottom:none; }
          #magnet-copy-panel .mcp-item .mcp-icon { flex:none; font-size:14px; }
          #magnet-copy-panel .mcp-item .mcp-info { flex:1 1 140px; min-width:0; }
          #magnet-copy-panel .mcp-item .mcp-name {
            overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
          }
          #magnet-copy-panel .mcp-item.error .mcp-name { color:#e74c3c; }
          #magnet-copy-panel .mcp-item .mcp-size { color:#999; font-size:11px; }
          #magnet-copy-panel .mcp-item button.mcp-copy {
            flex:none; background:#333; border:1px solid #555; color:#fff;
            border-radius:4px; padding:3px 7px; cursor:pointer; font-size:11px;
          }
          #magnet-copy-panel .mcp-item button.mcp-copy:hover { background:#444; }
          #magnet-copy-panel .mcp-item button.mcp-ad { border-color:#e67e22; }
          #magnet-copy-panel .mcp-item button.mcp-ad:disabled { opacity:.6; cursor:default; }
          #magnet-copy-panel .mcp-item button.mcp-dl { border-color:#3498db; }
          #magnet-copy-panel .mcp-copyall {
            flex:none; margin:6px; padding:7px; background:#2ecc71; color:#08321b;
            border:none; border-radius:6px; font-weight:bold; cursor:pointer;
          }
          #magnet-copy-panel .mcp-copyall:hover { filter:brightness(1.08); }
          #magnet-copy-panel .mcp-copyall:disabled { opacity:.4; cursor:default; }
        `;
        const inject = () => document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css }));
        if (document.head) inject();
        else document.addEventListener('DOMContentLoaded', inject);
    }

    function getPanel() {
        let el = document.getElementById('magnet-copy-panel');
        if (el) return el;
        el = document.createElement('div');
        el.id = 'magnet-copy-panel';
        el.innerHTML = `
          <div class="mcp-header">
            <span>🧲 Magnets extraits</span>
            <span class="mcp-header-btns">
              <button type="button" class="mcp-key" title="Changer la clé API AllDebrid">🔑</button>
              <button type="button" class="mcp-clear" title="Vider la liste">✕</button>
            </span>
          </div>
          <div class="mcp-list"></div>
          <button type="button" class="mcp-copyall">Copier tout</button>
        `;
        el.querySelector('.mcp-clear').addEventListener('click', () => {
            panelEntries = [];
            el.hidden = true;
        });
        el.querySelector('.mcp-key').addEventListener('click', () => {
            GM_setValue('alldebridApiKey', '');
            getAllDebridApiKey();
        });
        el.querySelector('.mcp-copyall').addEventListener('click', () => {
            const all = panelEntries.filter(e => e.state === 'ok').map(e => e.magnetURI);
            if (all.length) GM_setClipboard(all.join('\n'), 'text');
        });
        (document.body || document.documentElement).appendChild(el);
        return el;
    }

    function renderPanel() {
        const el = getPanel();
        el.hidden = panelEntries.length === 0;
        const list = el.querySelector('.mcp-list');
        list.innerHTML = '';
        panelEntries.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'mcp-item' + (entry.state === 'error' ? ' error' : '');
            const icon = entry.state === 'busy' ? '⏳' : entry.state === 'ok' ? '✅' : '❌';
            row.innerHTML = `
              <span class="mcp-icon">${icon}</span>
              <span class="mcp-info">
                <div class="mcp-name" title="${escapeHtml(entry.error || entry.name)}">${escapeHtml(entry.name)}</div>
                <div class="mcp-size">${entry.state === 'error' ? escapeHtml(entry.error) : formatSize(entry.size)}</div>
              </span>
            `;
            if (entry.state === 'ok') {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'mcp-copy';
                btn.textContent = 'Copier';
                btn.addEventListener('click', () => GM_setClipboard(entry.magnetURI, 'text'));
                row.appendChild(btn);

                const adBtn = document.createElement('button');
                adBtn.type = 'button';
                adBtn.className = 'mcp-copy mcp-ad';
                adBtn.textContent = 'AllDebrid';
                adBtn.title = 'Envoyer ce magnet à AllDebrid (clé demandée au premier usage)';
                adBtn.addEventListener('click', () => {
                    adBtn.disabled = true;
                    adBtn.textContent = '…';
                    adBtn.title = '';
                    sendMagnetToAllDebrid(entry.magnetURI)
                        .then(({ ready }) => {
                            adBtn.textContent = ready ? '✅ Prêt' : '✅ Envoyé';
                        })
                        .catch(err => {
                            adBtn.textContent = '❌';
                            adBtn.title = err.message || String(err);
                            adBtn.disabled = false;
                        });
                });
                row.appendChild(adBtn);

                if (entry.blob) {
                    const dlBtn = document.createElement('button');
                    dlBtn.type = 'button';
                    dlBtn.className = 'mcp-copy mcp-dl';
                    dlBtn.textContent = '.torrent';
                    dlBtn.title = 'Télécharger le vrai fichier .torrent (utile si AllDebrid refuse le magnet, limite ~100 Go)';
                    dlBtn.addEventListener('click', () => downloadBlobAsFile(entry.blob, torrentFilename(entry)));
                    row.appendChild(dlBtn);
                }
            }
            list.appendChild(row);
        });
        el.querySelector('.mcp-copyall').disabled = !panelEntries.some(e => e.state === 'ok');

        const last = list.lastElementChild;
        if (last) {
            last.classList.add('flash');
            setTimeout(() => last.classList.remove('flash'), 800);
        }
    }

    // ---------------------------------------------------------------------
    // Envoi optionnel à AllDebrid — jamais automatique : un clic explicite par
    // magnet, sur demande de l'utilisateur (compte AllDebrid déjà sensible,
    // cf. incidents de sécurité passés — pas question d'appeler ça en silence).
    // La clé API est stockée via GM_setValue (stockage Tampermonkey, propre à
    // ce navigateur), jamais écrite en clair dans le fichier du script.
    // ---------------------------------------------------------------------
    function getAllDebridApiKey() {
        const stored = GM_getValue('alldebridApiKey', '');
        if (stored) return stored;
        const entered = prompt(
            'Clé API AllDebrid (alldebrid.com → Compte → Clé API).\n' +
            'Stockée uniquement en local dans Tampermonkey, jamais dans le fichier du script.'
        );
        if (entered && entered.trim()) {
            GM_setValue('alldebridApiKey', entered.trim());
            return entered.trim();
        }
        return null;
    }

    function sendMagnetToAllDebrid(magnetURI) {
        const apiKey = getAllDebridApiKey();
        if (!apiKey) return Promise.reject(new Error('Clé API AllDebrid non fournie'));
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://api.alldebrid.com/v4/magnet/upload?agent=unit3d-magnet-copy&apikey=' + encodeURIComponent(apiKey),
                data: 'magnets[]=' + encodeURIComponent(magnetURI),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                onload: res => {
                    let data;
                    try {
                        data = JSON.parse(res.responseText);
                    } catch (e) {
                        reject(new Error('réponse AllDebrid illisible'));
                        return;
                    }
                    if (data.status !== 'success') {
                        reject(new Error((data.error && data.error.message) || 'échec AllDebrid'));
                        return;
                    }
                    const m = (data.data && data.data.magnets && data.data.magnets[0]) || {};
                    if (m.error) {
                        reject(new Error(m.error.message || 'magnet invalide'));
                        return;
                    }
                    resolve({ ready: !!m.ready });
                },
                onerror: () => reject(new Error('erreur réseau AllDebrid')),
            });
        });
    }

    function escapeHtml(str) {
        return String(str == null ? '' : str).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }
})();
