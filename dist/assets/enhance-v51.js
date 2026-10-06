/* Top G Leichtkraut — Erweiterungsschicht über der gebauten App.
   Enthält: (1) Kundensuche im "Neue E-Mail"-Feld, (2) Zeiterfassung per Heartbeat,
   (3) Team-Link in der Seitenleiste, (4) Sprachumschalter DE/EN für die Oberfläche.
   Wichtig: Der Umschalter ändert NUR die Anzeige. Kundenmails gehen weiterhin in
   der Sprache der Kundin raus — das entscheidet allein das Backend. */
(function () {
  var lkIstAdmin = false;
  var lkUserName = null;   // echter Name des eingeloggten Users (v31, Personalisierung)   // wird nach /api/auth/status gesetzt (22.08.)
  'use strict';

  // ── 1) ZEITERFASSUNG ──────────────────────────────────────────────────────
  // Alle 30 s eine Meldung, aber nur wenn das Fenster sichtbar ist und in den
  // letzten 3 Minuten Maus/Tastatur benutzt wurde. So zählen offene Tabs nicht mit.
  var lastInput = Date.now();
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function () { lastInput = Date.now(); }, { passive: true });
  });
  function heartbeat() {
    if (document.hidden) return;
    if (Date.now() - lastInput > 180000) return;
    fetch('/api/track/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .catch(function () {});
  }
  setInterval(heartbeat, 30000);
  setTimeout(heartbeat, 3000);

  // ── 2) SPRACHE ────────────────────────────────────────────────────────────
  var DICT = {
    // Navigation & Ordner
    'Posteingang': 'Inbox', 'Entwürfe': 'Drafts', 'Meine Erstellten': 'Sent by me',
    'Gelöst': 'Resolved', 'Spam': 'Spam', 'Alle Offenen': 'All open',
    'Dashboard': 'Dashboard', 'Analytics': 'Analytics', 'Workflows': 'Workflows',
    'Organisation': 'Organization', 'Integrationen': 'Integrations', 'Team': 'Team',
    'Help Center': 'Help Center', 'E-Mail-Kanäle': 'Email channels',
    'Rücksendungen': 'Returns', 'Disputes': 'Disputes', 'Klarna-Fälle': 'Klarna cases',
    'Klarna Fälle': 'Klarna cases', 'Übersicht': 'Overview', 'KI-Agenten': 'AI agents',
    // Aktionen
    'Senden': 'Send', 'Schließen': 'Close', 'Abbrechen': 'Cancel', 'Speichern': 'Save',
    'Suchen': 'Search', 'Suchen...': 'Search...', 'Neue E-Mail': 'New email',
    'Neue E-Mail schreiben': 'Compose new email', 'Als Entwurf anlegen': 'Save as draft',
    'Wieder öffnen': 'Reopen', 'In Erstellte': 'Move to sent', 'Verwalten': 'Manage',
    'Testen': 'Test', 'Verbinden': 'Connect', 'Trennen': 'Disconnect',
    'Tag hinzufügen': 'Add tag', 'Tag entfernen': 'Remove tag', 'Vorlagen': 'Templates',
    'Bild oder Datei anhängen': 'Attach image or file', 'Zurück nach Posteingang': 'Back to inbox',
    'Antwort verwerfen und neu generieren': 'Discard reply and regenerate',
    'Nach Meine Erstellten verschieben (ohne zu antworten)': 'Move to sent (without replying)',
    'Zitierten Verlauf anzeigen': 'Show quoted history', 'Dunkler Modus': 'Dark mode',
    'Ausklappen': 'Expand', 'Einklappen': 'Collapse', 'Zurück zum Postfach': 'Back to inbox',
    // Felder & Labels
    'AN': 'TO', 'BETREFF': 'SUBJECT', 'Betreff…': 'Subject…', 'Betreff...': 'Subject...',
    'Name': 'Name', 'Passwort': 'Password', 'Sprache': 'Language', 'Status': 'Status',
    'Priorität': 'Priority', 'Kunde': 'Customer', 'Kundendaten': 'Customer data',
    'Kundendetails': 'Customer details', 'Bestellungen': 'Orders', 'Bestellung': 'Order',
    'Versandadresse': 'Shipping address', 'Sendungsverfolgung': 'Tracking',
    'Artikel': 'items', 'Gesamt': 'Total', 'Aktion': 'Action', 'Aktiv': 'Active',
    'Alle': 'All', 'Alle Status': 'All statuses', 'Alle Kanäle': 'All channels',
    'Allgemein': 'General', 'Erstellt': 'Created', 'Ereignis': 'Event', 'Ereignisse': 'events',
    'Tickets': 'Tickets', 'Ticket-Volumen': 'Ticket volume', 'Fehler': 'Error',
    'Manuell': 'Manual', 'Antwort erforderlich': 'Response required',
    'Angefochten': 'Disputed', 'In Prüfung': 'Under review', 'Erstattet': 'Refunded',
    'Verloren': 'Lost', 'Gewonnen': 'Won', 'Auf Hold': 'On hold', 'Offen': 'Open',
    'Produkt nicht erhalten': 'Product not received', 'Bezahlt': 'Paid', 'Versendet': 'Shipped',
    'Kein Ticket ausgewählt': 'No ticket selected', 'Keine Tickets in diesem Ordner.': 'No tickets in this folder.',
    'Kein Betreff': 'No subject', '(Kein Betreff)': '(No subject)',
    'Keine Bestellungen zu dieser E-Mail gefunden': 'No orders found for this email',
    'KI-Funktion': 'AI feature', 'Test fehlgeschlagen.': 'Test failed.',
    'Interne Notiz': 'Internal note', 'Konsequenz einer schlechten Antwort': 'Impact of a poor reply',
    'kundin@example.com': 'customer@example.com', 'Liebe Frau …': 'Dear Ms …',
    'NACHRICHT (OPTIONAL — KANNST DU AUCH IM ENTWURF SCHREIBEN)': 'MESSAGE (OPTIONAL — YOU CAN ALSO WRITE IT IN THE DRAFT)'
  ,
    // v8: restliche UI-Strings aus dem Bundle
    'AI nicht verbunden — hinterlege einen Anthropic-Key unter Integrationen.': 'AI not connected — add an Anthropic key under Integrations.',
    'AI-Fehler': 'AI error',
    'Aktuell offene Tickets': 'Currently open tickets',
    'Alle Kunden, die mit deinem Support in Kontakt getreten sind.': 'All customers who have been in touch with your support.',
    'Als Klarna-Fall markieren': 'Mark as Klarna case',
    'Als Rücksendung PP markieren': 'Mark as return PP',
    'Anteil ganz ohne menschliche Antwort gelöst': 'Share resolved without any human reply',
    'Antwortvorlagen — direkt im Composer über das Klemmbrett-Icon einfügbar.': 'Reply templates — insert directly in the composer via the clipboard icon.',
    'Artikel und Sammlungen durchsuchen': 'Search products and collections',
    'Ausführungen': 'Runs',
    'Automatisierungen und Workflows verwalten': 'Manage automations and workflows',
    'Barbara von Leichtkraut': 'Barbara from Leichtkraut',
    'Beschädigt': 'Damaged',
    'Bestellnummer aus der Mail': 'Order number from the email',
    'Durchschn. Zeit bis zur ersten Antwort': 'Avg. time to first reply',
    'E-Mails verwalten': 'Manage emails',
    'Einzigartige Kunden': 'Unique customers',
    'Ereignis-Trigger': 'Event trigger',
    'Erstellte Tickets': 'Tickets created',
    'Fläche': 'Area',
    'Gelöste Tickets': 'Resolved tickets',
    'Gesamtzahl KI-generierter Antworten': 'Total AI-generated replies',
    'Gesamtzahl erstellter Tickets': 'Total tickets created',
    'Gesamtzahl gelöster Tickets': 'Total tickets resolved',
    'Gruppiere Kontakte nach Unternehmen.': 'Group contacts by company.',
    'Gruppiert nach KI-Klassifizierung': 'Grouped by AI classification',
    'Gruppiert nach Kalendertag': 'Grouped by calendar day',
    'Gruppiert nach Kalenderwoche': 'Grouped by calendar week',
    'Gruppiert nach Kommunikationskanal': 'Grouped by communication channel',
    'Gruppiert nach Ticket-Kategorie': 'Grouped by ticket category',
    'Gruppiert nach Ticket-Priorität': 'Grouped by ticket priority',
    'Gruppiert nach Ticket-Status': 'Grouped by ticket status',
    'Gruppiert nach Wochentag': 'Grouped by weekday',
    'Gruppiert nach zugewiesenem Agenten': 'Grouped by assigned agent',
    'Im ersten Kontakt gelöst': 'Resolved on first contact',
    'KI-Antworten': 'AI replies',
    'Kanäle': 'Channels',
    'Kategorisiere und organisiere deine Tickets mit Stichwörtern.': 'Categorize and organize your tickets with tags.',
    'Keine MX-Records gefunden.': 'No MX records found.',
    'Keine Wirkung': 'No effect',
    'Kontakte werden automatisch angelegt': 'Contacts are created automatically',
    'Lege Firmen an, um Kontakte und Tickets zu bündeln.': 'Create companies to group contacts and tickets.',
    'Lila Klarna Fälle-Tag entfernen': 'Remove purple Klarna cases tag',
    'Median Lösungszeit (Std.)': 'Median resolution time (hrs)',
    'Median der Lösungszeit': 'Median resolution time',
    'Metriken und Berichte abfragen': 'Query metrics and reports',
    'Mitglieder verwalten': 'Manage members',
    'Name der Vorlage:': 'Template name:',
    'Nicht autorisiert': 'Not authorized',
    'Nicht verbunden': 'Not connected',
    'Noch keine Firmenprofile': 'No company profiles yet',
    'ODER': 'OR',
    'Offene Tickets (Backlog)': 'Open tickets (backlog)',
    'Panel hinzufügen': 'Add panel',
    'Prozent durch KI bearbeitet': 'Percent handled by AI',
    'Rücksendung OVP': 'Return OVP',
    'Rücksendung Offen': 'Return open',
    'Rücksendung PP': 'Return PP',
    'Rücksendung offen': 'Return open',
    'SLA & Priorität': 'SLA & priority',
    'Sendungsnummer aus der Mail': 'Tracking number from the email',
    'Shopify verbinden für Live-Bestelldaten.': 'Connect Shopify for live order data.',
    'Sobald ein Kunde ein Ticket erstellt, erscheint sein Profil hier.': 'As soon as a customer creates a ticket, their profile appears here.',
    'Speichern & aktivieren': 'Save & activate',
    'Stichwörter': 'Tags',
    'Tage': 'days',
    'Text der Vorlage:': 'Template text:',
    'Tickets suchen, lesen, beantworten und aktualisieren': 'Search, read, reply to and update tickets',
    'UND': 'AND',
    'Uhr — bis dahin lösen oder Beweis einreichen.': '— resolve or submit evidence by then.',
    'Unterschiedliche Kunden': 'Distinct customers',
    'Verbinde externe KI-Tools über das Model Context Protocol mit deinem Workspace.': 'Connect external AI tools to your workspace via the Model Context Protocol.',
    'Verbindung erfolgreich!': 'Connection successful!',
    'Verfügbare Tool-Kategorien': 'Available tool categories',
    'Verwalte die Einstellungen deiner Organisation.': 'Manage your organization settings.',
    'Vorlage erstellen': 'Create template',
    'Ware nicht wie beschrieben': 'Item not as described',
    'Woche': 'Week',
    'Zitierten Verlauf ausblenden': 'Hide quoted history'
  };
  var RE_ANTWORT = /^Antwort an (.+) schreiben$/;
  // Die Sprache haengt am BENUTZERKONTO, nicht am Browser: So sieht derselbe
  // Mitarbeiter an jedem Geraet Englisch — und das Backend liefert ihm passend
  // dazu auch die Postfach-Inhalte uebersetzt aus.
  var lang = localStorage.getItem('lk_lang') || 'de';
  var langSynced = false;
  var userRole = null;
  fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (s) {
    userRole = (s && s.user && s.user.role) || null;
    var box0 = document.getElementById('lk-side-tools');
    if (box0) { box0.remove(); ensureSidebar(); }
    var server = (s && s.user && s.user.uiLang) || 'de';
    // SPRACH-PIN (21.08.): Fuer Nicht-Admins (z. B. Mitarbeiterin C als agent) wird der
    // Sprachumschalter gar nicht erst gerendert - die Sprache ist gepinnt.
    // KORREKTUR 22.08.: istAdmin muss GLOBAL sein - ensureSidebar laeuft in
    // anderem Scope; die lokale Variable warf dort einen ReferenceError und
    // liess die ganze Zusatzleiste (inkl. Team-Knopf) verschwinden.
    lkIstAdmin = !!(s && s.user && s.user.role === 'admin');
    lkUserName = (s && s.user && s.user.name) || null;
    langSynced = true;
    if (server !== lang) {
      lang = server;
      localStorage.setItem('lk_lang', lang);
      var b = document.getElementById('lk-lang-skip');
      if (b) renderLangBtn(b);
      applyLang();
    }
  }).catch(function () {});

  function translate(txt) {
    var t = txt.trim();
    if (!t) return null;
    if (Object.prototype.hasOwnProperty.call(DICT, t)) return txt.replace(t, DICT[t]);
    var m = t.match(RE_ANTWORT);
    if (m) return txt.replace(t, 'Write a reply to ' + m[1]);
    return null;
  }

  var walking = false;
  function applyLang() {
    if (lang !== 'en' || walking) return;
    walking = true;
    try {
      var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentElement;
          if (!p) return NodeFilter.FILTER_REJECT;
          var tag = p.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'PRE') return NodeFilter.FILTER_REJECT;
          if (p.closest('#lk-lang-skip')) return NodeFilter.FILTER_REJECT;
          return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      var nodes = [], n;
      while ((n = w.nextNode())) nodes.push(n);
      nodes.forEach(function (node) {
        var out = translate(node.nodeValue);
        if (out !== null && out !== node.nodeValue) node.nodeValue = out;
      });
      // Platzhalter & Tooltips
      document.querySelectorAll('input[placeholder],textarea[placeholder]').forEach(function (el) {
        var t = translate(el.getAttribute('placeholder'));
        if (t !== null) el.setAttribute('placeholder', t);
      });
      document.querySelectorAll('[title],[aria-label]').forEach(function (el) {
        ['title', 'aria-label'].forEach(function (a) {
          var v = el.getAttribute(a); if (!v) return;
          var t = translate(v); if (t !== null) el.setAttribute(a, t);
        });
      });
    } finally { walking = false; }
  }

  // ── 3) SEITENLEISTE: Team-Button + Sprachumschalter ───────────────────────
  function iconBtn(title, svg, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.setAttribute('aria-label', title);
    b.className = 'lk-side-btn';
    b.innerHTML = svg;
    b.addEventListener('click', onClick);
    return b;
  }

  // Die Leiste haengt NICHT mehr am App-DOM. Frueher wurde das Zahnrad ueber
  // svg.lucide-settings gesucht - diese Klasse setzt das Bundle aber nie
  // (className:wO("lucide", i) ohne Iconnamen), also gab es nie einen Anker und
  // damit nie einen Knopf. Fest positioniert kann das nicht mehr passieren.
  var langBusy = false;

  function renderLangBtn(btn) {
    btn.disabled = false;
    btn.innerHTML = '<span style="font-size:11px;font-weight:800;letter-spacing:.02em">' +
      (lang === 'de' ? 'DE' : 'EN') + '</span>';
    btn.title = lang === 'de'
      ? 'Auf Englisch umschalten \u2014 Oberfl\u00e4che und Postfach'
      : 'Switch to German \u2014 interface and inbox';
  }

  function toast(msg, ok) {
    var t = document.getElementById('lk-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'lk-toast';
      t.style.cssText = 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
        'z-index:2147483001;padding:11px 16px;border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;' +
        'max-width:420px;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.22);pointer-events:none';
      document.body.appendChild(t);
    }
    t.style.background = ok ? '#1f6f4f' : '#a3312a';
    t.style.color = '#fff';
    t.textContent = msg;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 4200);
  }

  function ensureSidebar() {
    if (document.getElementById('lk-side-tools')) return;
    if (!document.body) return;

    var box = document.createElement('div');
    box.id = 'lk-side-tools';
    // v42 (Samuel 05.09.): nicht mehr ueber den Icons der App unten links, sondern als
    // flache Leiste rechts daneben am Fuss der Ordnerspalte.
    box.style.cssText = 'position:fixed;left:134px;bottom:14px;z-index:2147483000;' +
      'display:flex;flex-direction:row;gap:6px;align-items:center;padding:5px 7px;' +
      'border-radius:12px;background:rgba(128,128,128,.13);backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px)';

    // Admins sehen das ganze Team, Mitarbeitende ihre eigene Auswertung.
    // Beide bekommen einen Knopf, nur das Ziel unterscheidet sich.
    if (userRole === 'admin') {
      var teamSvg = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
      box.appendChild(iconBtn('Team', teamSvg, function () { location.href = '/team'; }));
      // v43 (Samuel 05.09.): Kommentare sind ein eigenes Tool (kommentare.leichtkraut.de), kein Knopf mehr hier.
      // ABMELDEN (v29, Samuel 22.08.): Garantierter Logout-Knopf fuer ALLE
      // Rollen - unabhaengig davon, was die App selbst anbietet. Beendet die
      // Session serverseitig und fuehrt zur Login-Seite.
      var logoutSvg = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>';
      box.appendChild(iconBtn(lang === 'en' ? 'Log out' : 'Abmelden', logoutSvg, function () {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
          .catch(function () {})
          .then(function () { location.href = '/login'; });
      }));
    } else if (userRole) {
      var meSvg = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><rect x="7" y="12" width="3" height="6" rx="1"/><rect x="12" y="8" width="3" height="10" rx="1"/><rect x="17" y="4" width="3" height="14" rx="1"/></svg>';
      box.appendChild(iconBtn(lang === 'en' ? 'My work' : 'Meine Arbeit', meSvg, function () { location.href = '/me'; }));
    }

    if (!lkIstAdmin) return;   // 21.08.: Sprach-Button nur fuer Admin (22.08. Scope-Fix)
    var langBtn = iconBtn('', '', function () {
      if (langBusy) return;                       // Doppelklick wuerde zurueckschalten
      langBusy = true;
      var next = (lang === 'de') ? 'en' : 'de';
      langBtn.disabled = true;
      langBtn.innerHTML = '<span style="font-size:10px;opacity:.7">\u2026</span>';
      fetch('/api/auth/lang', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang: next })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        if (!d || d.lang !== next) throw new Error('nicht gespeichert');
        // Erst wenn das KONTO umgestellt ist, schalten wir die Oberflaeche um -
        // sonst zeigt das Tool Englisch, liefert aber deutsche Inhalte.
        localStorage.setItem('lk_lang', next);
        location.reload();
      })['catch'](function (e) {
        langBusy = false;
        renderLangBtn(langBtn);
        toast('Sprache konnte nicht umgestellt werden (' + e.message + '). Bitte neu anmelden und erneut versuchen.', false);
      });
    });
    langBtn.id = 'lk-lang-skip';
    renderLangBtn(langBtn);
    box.appendChild(langBtn);

    document.body.appendChild(box);

    if (!document.getElementById('lk-side-style')) {
      var st = document.createElement('style');
      st.id = 'lk-side-style';
      st.textContent = '.lk-side-btn{width:34px;height:34px;border:0;border-radius:9px;background:transparent;' +
        'color:currentColor;opacity:.72;cursor:pointer;display:flex;align-items:center;justify-content:center}' +
        '.lk-side-btn:hover{opacity:1;background:rgba(127,127,127,.2)}' +
        '.lk-side-btn:disabled{cursor:default}' +
        '.lk-side-btn:focus-visible{outline:2px solid #2f7d5f;outline-offset:2px}';
      document.head.appendChild(st);
    }
  }

  // ── 4) KUNDENSUCHE im AN-Feld (unverändert aus v4) ────────────────────────
  var cache = null, cacheAt = 0, items = [], sel = -1;
  function getContacts() {
    if (cache && Date.now() - cacheAt < 60000) return Promise.resolve(cache);
    return fetch('/api/inbound/kurz').then(function (r) { return r.json(); }).then(function (d) {
      var list = (d && (d.tickets || d)) || [], seen = {}, out = [];
      for (var i = 0; i < list.length; i++) {
        var e = String(list[i].customer_email || '').trim(), n = String(list[i].customer_name || '').trim();
        if (!e || e.indexOf('@') < 0) continue;
        if (/leichtkraut\.de|shopify\.com|mailer@|no-?reply/i.test(e)) continue;
        var k = e.toLowerCase(); if (seen[k]) continue; seen[k] = 1;
        out.push({ email: e, name: n });
      }
      out.sort(function (a, b) { return (a.name || a.email).localeCompare(b.name || b.email); });
      cache = out; cacheAt = Date.now(); return out;
    }).catch(function () { return cache || []; });
  }
  function setReactValue(input, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function findAnInput() {
    var els = document.querySelectorAll('label, div, span, p');
    for (var i = 0; i < els.length; i++) {
      var el = els[i], t = el.textContent && el.textContent.trim().toUpperCase();
      if (el.children.length === 0 && (t === 'AN' || t === 'TO')) {
        var scope = el.parentElement, inp = scope && scope.querySelector('input');
        if (inp) return inp;
        var sib = el.nextElementSibling;
        while (sib) {
          if (sib.tagName === 'INPUT') return sib;
          var q = sib.querySelector && sib.querySelector('input'); if (q) return q;
          sib = sib.nextElementSibling;
        }
      }
    }
    return null;
  }
  function ensureBox(inp) {
    var host = inp.parentElement; if (!host) return null;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    var b = host.querySelector(':scope > .lk-suggest');
    if (!b) {
      b = document.createElement('div'); b.className = 'lk-suggest';
      b.style.cssText = 'position:absolute;left:0;top:100%;margin-top:4px;width:100%;box-sizing:border-box;z-index:2147483647;' +
        'background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.16);' +
        'max-height:280px;overflow-y:auto;font-family:Inter,Arial,sans-serif;font-size:13px;padding:4px;display:none;color:#111';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); });
      host.appendChild(b);
    }
    return b;
  }
  function hideBox(inp) {
    var host = inp && inp.parentElement, b = host && host.querySelector(':scope > .lk-suggest');
    if (b) b.style.display = 'none'; sel = -1;
  }
  function paintSel(b) { for (var i = 0; i < b.children.length; i++) b.children[i].style.background = (i === sel) ? '#eef2f0' : 'transparent'; }
  function choose(inp, idx) { var c = items[idx]; if (!c) return; setReactValue(inp, c.email); hideBox(inp); inp.focus(); }
  function render(inp, matches) {
    var b = ensureBox(inp); if (!b) return;
    items = matches;
    if (!matches.length) { b.style.display = 'none'; return; }
    b.innerHTML = '';
    matches.forEach(function (c, idx) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;flex-direction:column;gap:1px';
      var nm = document.createElement('span'); nm.style.cssText = 'font-weight:600;color:#0f2a20'; nm.textContent = c.name || c.email;
      row.appendChild(nm);
      if (c.name) { var em = document.createElement('span'); em.style.cssText = 'color:#3e6857;font-size:12px'; em.textContent = c.email; row.appendChild(em); }
      row.addEventListener('mouseenter', function () { sel = idx; paintSel(b); });
      row.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); });
      row.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); choose(inp, idx); });
      b.appendChild(row);
    });
    sel = 0; paintSel(b); b.style.display = 'block';
  }
  function update(inp) {
    var q = inp.value.trim().toLowerCase();
    getContacts().then(function (all) {
      var m = !q ? all.slice(0, 8) : all.filter(function (c) {
        return c.email.toLowerCase().indexOf(q) >= 0 || (c.name && c.name.toLowerCase().indexOf(q) >= 0);
      }).slice(0, 8);
      render(inp, m);
    });
  }
  function attachSuggest(inp) {
    if (inp.__lkBound) return; inp.__lkBound = true;
    inp.setAttribute('autocomplete', 'off');
    inp.addEventListener('focus', function () { update(inp); });
    inp.addEventListener('input', function () { update(inp); });
    inp.addEventListener('keydown', function (e) {
      var host = inp.parentElement, b = host && host.querySelector(':scope > .lk-suggest');
      if (!b || b.style.display === 'none') return;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, items.length - 1); paintSel(b); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paintSel(b); }
      else if (e.key === 'Enter') { if (sel >= 0 && items.length) { e.preventDefault(); choose(inp, sel); } }
      else if (e.key === 'Escape') hideBox(inp);
    });
    inp.addEventListener('blur', function () { setTimeout(function () { hideBox(inp); }, 150); });
  }

  // ── Takt ──────────────────────────────────────────────────────────────────
  var scheduled = false;
  function tick() {
    if (scheduled) return; scheduled = true;
    setTimeout(function () {
      scheduled = false;
      try { ensureSidebar(); } catch (e) {}
      try { var inp = findAnInput(); if (inp) attachSuggest(inp); } catch (e) {}
      try { applyLang(); } catch (e) {}
    }, 200);
  }
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(tick, 800);
  setTimeout(tick, 2000);
  // ── 5) TICKET-SPRUNG (v12, 05.08.) ──────────────────────────────────────
  // Samuel (05.08.): "wieso kann ich die ticket nummern nicht finden über die
  // search bar". Der v11-Handler suchte den Placeholder ("such"/"search"),
  // in der aktuellen App-Version passt das nicht mehr. Neu: eigenes, immer
  // sichtbares Sprungfeld oben rechts + Ctrl+K-Shortcut + placeholder-freier
  // Enter-Fallback in der internen Suche.
  // GETEILTER ABRUF (v19, 14.08.): Bis v18 hatte JEDE Zusatzfunktion ihren
  // eigenen fetch auf /api/inbound - Entruempelung alle 3 s, Ansichts-Waechter
  // alle 1,5 s, dazu der Ticket-Cache. Zusammen mit dem 4-Sekunden-Takt der App
  // ergab das ~38 Abrufe pro Minute a 2,8 MB. Der Browser kam mit dem Auswerten
  // nicht mehr hinterher und die Oberflaeche stand. Ab jetzt: EIN Abruf, den
  // sich alle teilen, und parallele Aufrufe warten auf dieselbe Antwort statt
  // eine zweite zu starten.
  var __lkTicketCache = { at: 0, tickets: [], laeuft: null };
  async function loadTicketCache() {
    var now = Date.now();
    if (now - __lkTicketCache.at < 2500 && __lkTicketCache.tickets.length) return __lkTicketCache.tickets;
    if (__lkTicketCache.laeuft) return __lkTicketCache.laeuft;   // schon unterwegs: mitbenutzen
    __lkTicketCache.laeuft = (async function () {
      try {
        var r = await fetch('/api/inbound/kurz', { credentials: 'include' });   // schlanke Liste, 1/20 der Groesse
        var d = await r.json();
        var list = (d && (d.tickets || d)) || [];
        __lkTicketCache = { at: Date.now(), tickets: list, laeuft: null };
        return list;
      } catch (e) {
        __lkTicketCache.laeuft = null;
        return __lkTicketCache.tickets || [];
      }
    })();
    return __lkTicketCache.laeuft;
  }
  async function jumpToTicket(num) {
    var list = await loadTicketCache();
    var t = null, n = String(num);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].ticket_number) === n) { t = list[i]; break; }
    }
    if (!t) { toast('Ticket #' + n + ' nicht gefunden', false); return; }
    var m = location.pathname.match(/\/workspace\/([^/]+)\/inbox/);
    if (m) { location.href = '/workspace/' + m[1] + '/inbox/' + t.id; return; }
    var m2 = location.pathname.match(/\/workspace\/([^/]+)\//);
    if (m2) { location.href = '/workspace/' + m2[1] + '/inbox/' + t.id; return; }
    toast('Nicht in einem Workspace', false);
  }

  // Sprungbox entfernt (Samuel, 14.08.: stoert oben rechts). Die Funktion
  // bleibt als Aufraeumer bestehen, damit alte Aufrufstellen und ein evtl.
  // noch gerendertes Element aus einer offenen Sitzung harmlos verschwinden.
  function ensureJumpBox() {
    var alt = document.getElementById('lk-jump-box');
    if (alt) alt.remove();
  }

  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    if (el.id === 'lk-jump-input') return;
    var v = String(el.value || '').trim();
    var mm = v.match(/^#?\s*(\d{3,6})$/);
    if (!mm) return;
    e.preventDefault(); e.stopPropagation();
    jumpToTicket(mm[1]);
  }, true);

  // ── 6) SIMPLE AS FUCK + CONFIDENCE (v13, 06.08.) ─────────────────────────
  // Samuels Ansage: Ticketliste entrümpeln. Rating (x/10), Priorität, Uhr,
  // Mitarbeiter- und Tag-Icons raus. Bleibt: Ticketnummer + Confidence-Badge.
  // Anker ist der Ticketnummer-Chip (#NNNN als exakter Text) — das ist ein
  // Daten-Anker, kein Klassen-Anker (Memory-Regel: nie an Icon-Klassen hängen).
  // Schwellen von Samuel bestätigt: >=60 grün, 40-59 gelb, <40 rot.
  var __lkConf = { at: 0, map: {}, action: {} };
  async function loadConfidence() {
    var now = Date.now();
    if (now - __lkConf.at < 20000) return __lkConf.map;
    try {
      var list = await loadTicketCache();
      var map = {};
      var action = {};
      var reak = {};
      var schlummer = {};
      var reakHeute = { p: 0, m: 0, n: 0 };
      var heute = new Date().toISOString().slice(0, 10);
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t || t.ticket_number == null) continue;
        if (typeof t.ai_confidence === 'number') map[String(t.ticket_number)] = t.ai_confidence;
        if (t.action_required) action[String(t.ticket_number)] = String(t.action_required);
        if (t.snooze_until) schlummer[String(t.ticket_number)] = String(t.snooze_until);
        if (t.reaction) {
          reak[String(t.ticket_number)] = String(t.reaction);
          if (t.reaction_at && String(t.reaction_at).slice(0, 10) === heute) {
            if (t.reaction === 'positiv') reakHeute.p++;
            else if (t.reaction === 'negativ') reakHeute.n++;
            else reakHeute.m++;
          }
        }
      }
      __lkConf = { at: now, map: map, action: action, reak: reak, reakHeute: reakHeute, schlummer: schlummer };
    } catch (e) {}
    return __lkConf.map;
  }
  function confColors(score) {
    if (score >= 60) return { bg: '#e5f4e8', fg: '#1d6b30', bd: '#bfe3c8' };
    if (score >= 40) return { bg: '#fdf3d7', fg: '#8a6d00', bd: '#f0dfa0' };
    return { bg: '#fde8e8', fg: '#b42318', bd: '#f5c2be' };
  }
  // Vom Text-Blatt zum obersten Element klettern, das denselben Text trägt —
  // so landen wir beim ganzen Chip (inkl. Icon), nicht beim inneren Span.
  function topmostSameText(el) {
    var t = String(el.textContent || '').trim();
    var n = el;
    while (n.parentElement
      && String(n.parentElement.textContent || '').trim() === t
      && n.parentElement.id !== 'lk-jump-box'
      && !/^(body|html)$/i.test(n.parentElement.tagName)) n = n.parentElement;
    return n;
  }
  function leafNodes(sel, re) {
    var out = [];
    var all = document.querySelectorAll(sel);
    for (var i = 0; i < all.length; i++) {
      if (all[i].childElementCount === 0 && re.test(String(all[i].textContent || '').trim())) out.push(all[i]);
    }
    return out;
  }
  function declutterRows() {
    var map = __lkConf.map || {};
    // SELBSTHEILUNG (v15): React verwendet DOM-Knoten beim Neu-Rendern wieder.
    // Ein früher gesetztes display:none kann dadurch auf einem Element kleben,
    // das inzwischen Name/Betreff trägt (Bug #1520: leere Ticket-Karte).
    // Deshalb: Jeder Durchlauf stellt ZUERST alles wieder her und blendet dann
    // anhand des aktuellen DOM frisch aus. Läuft synchron, also ohne Flackern.
    var hidden = document.querySelectorAll('[data-lk-hid]');
    for (var h = 0; h < hidden.length; h++) {
      hidden[h].style.display = '';
      hidden[h].removeAttribute('data-lk-hid');
    }
    // SCHNELLHEILUNG (v37): Ausserhalb des Posteingangs duerfen NIE Zeilen
    // versteckt sein - Reste aus Knoten-Wiederverwendung sofort zeigen,
    // nicht erst beim naechsten 2,5s-Takt.
    try {
      if (aktiverOrdnerName() !== 'Posteingang') {
        var weg2 = document.querySelectorAll('[data-lk-zeile-weg]');
        for (var w2 = 0; w2 < weg2.length; w2++) {
          weg2[w2].style.display = '';
          weg2[w2].removeAttribute('data-lk-zeile-weg');
        }
      }
    } catch (eSchnell) {}
    // Verwaiste Badges entfernen: Ein Badge gehört direkt hinter seinen
    // Nummern-Chip. Hat React die Zeile umgebaut, fliegt das alte Badge raus
    // (Bug: doppeltes 55%-Badge).
    var badges = document.querySelectorAll('.lk-conf, .lk-act, .lk-zuf');
    for (var b = 0; b < badges.length; b++) {
      var prev = badges[b].previousElementSibling;
      var anchorOk = false;
      if (badges[b].className === 'lk-conf') {
        anchorOk = !!prev && /^#\d{3,5}$/.test(String(prev.textContent || '').trim());
      } else if (badges[b].className === 'lk-act') {
        anchorOk = !!prev && prev.className === 'lk-conf';
      } else {
        anchorOk = !!prev && (prev.className === 'lk-conf' || prev.className === 'lk-act');
      }
      if (!anchorOk) badges[b].remove();
    }
    function hide(el) {
      if (!el) return;
      el.style.display = 'none';
      el.setAttribute('data-lk-hid', '1');
    }
    // Pass 1: Rating-Chips ("8/10") komplett ausblenden
    var ratings = leafNodes('span,div', /^\d{1,2}\/10$/);
    for (var r = 0; r < ratings.length; r++) {
      hide(topmostSameText(ratings[r]));
    }
    // Pass 2: Footer-Zeile über den Ticketnummer-Chip finden und entrümpeln
    var nums = leafNodes('span,div', /^#\d{3,5}$/);
    for (var i = 0; i < nums.length; i++) {
      var numChip = topmostSameText(nums[i]);
      var row = numChip.parentElement;
      if (!row || row.id === 'lk-jump-box') continue;
      // Nur in der Ticketliste eingreifen: die Footer-Zeile hat neben dem
      // Nummern-Chip weitere Elemente (Icons/Rating). Einzelne Nummern-Chips
      // an anderen Stellen bleiben unberührt.
      if (row.children.length < 3 && !row.querySelector(':scope > .lk-conf')) continue;
      var kids = row.children;
      for (var k = 0; k < kids.length; k++) {
        var kid = kids[k];
        if (kid === numChip || kid.className === 'lk-conf' || kid.className === 'lk-act') continue;
        // Schutzschranke: Nur kurze Chips (Rating, Zeit, Icons ohne Text)
        // ausblenden. Alles mit echtem Textinhalt (Name, Betreff) bleibt
        // IMMER sichtbar, egal wie die Struktur gerade aussieht.
        if (String(kid.textContent || '').trim().length > 12) continue;
        hide(kid);
      }
      // Confidence-Badge einhängen/aktualisieren
      var tnum = String(numChip.textContent || '').trim().replace('#', '');
      var score = map[tnum];
      var badge = row.querySelector(':scope > .lk-conf');
      if (typeof score !== 'number') { if (badge) badge.style.display = 'none'; continue; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'lk-conf';
        badge.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.2px;border:1px solid transparent;';
        numChip.insertAdjacentElement('afterend', badge);
      }
      var c = confColors(score);
      badge.style.display = 'inline-flex';
      badge.style.background = c.bg;
      badge.style.color = c.fg;
      badge.style.borderColor = c.bd;
      badge.textContent = score + '%';
      badge.title = 'Barbara-Confidence: Wie sicher ist dieser Entwurf? (' + (score >= 60 ? 'gut' : score >= 40 ? 'bitte prüfen' : 'Achtung, genau lesen') + ')';
      // Pflicht-Aktion (z.B. "Rückerstattung nötig") — unübersehbar in Rot,
      // Samuels Ansage vom 06.08. für Fälle wie Kundin #1478.
      var act = (__lkConf.action || {})[tnum];
      var actBadge = row.querySelector(':scope > .lk-act');
      if (act) {
        if (!actBadge) {
          actBadge = document.createElement('span');
          actBadge.className = 'lk-act';
          actBadge.style.cssText = 'display:inline-flex;align-items:center;margin-left:6px;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.2px;background:#b42318;color:#fff;border:1px solid #8e1c13;';
          badge.insertAdjacentElement('afterend', actBadge);
        }
        actBadge.style.display = 'inline-flex';
        actBadge.textContent = '⚠ ' + act;
        actBadge.title = 'Pflicht-Aktion laut Prüfung: ' + act;
      } else if (actBadge) {
        actBadge.style.display = 'none';
      }
      // (v34: Zufriedenheits-Emoji wieder entfernt - lebt jetzt in der
      // Team-Ansicht /team, Samuel 23.08. Aufraeumer entsorgt Altbestand.)
    }
  }
  var declutterScheduled = false;
  function scheduleDeclutter() {
    if (declutterScheduled) return; declutterScheduled = true;
    setTimeout(function () {
      declutterScheduled = false;
      loadConfidence().then(function () { try { declutterRows(); } catch (e) {} });
    }, 250);
  }

  // ── 7) NACH DEM SENDEN SCHLIESSEN (v16, 08.08.) ──────────────────────────
  // Samuels Bug-Meldung: Nach dem Senden blieb die Mail offen stehen und das
  // Ticket weiter im Posteingang. Ursache ist NICHT der Server (der setzt den
  // Status sofort auf "answered"), sondern die App: Sie lädt die Liste erst
  // beim nächsten Poll neu und schließt die geöffnete Mail nicht.
  // Lösung: Nach dem Klick auf "Senden" beim Server nachfragen, ob das Ticket
  // wirklich beantwortet ist. Erst DANN zurück in die Liste springen. Schlägt
  // der Versand fehl, bleibt alles stehen, damit kein Text verloren geht.
  function currentTicketId() {
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/(\d+)/);
    return m ? m[1] : null;
  }
  async function ticketIstBeantwortet(id) {
    try {
      var list = await loadTicketCache();
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) {
          return ['answered', 'resolved', 'closed'].indexOf(String(list[i].status)) >= 0;
        }
      }
    } catch (e) {}
    return false;
  }
  // ── SANFT ZUR LISTE (v29, 14.08.) ────────────────────────────────────────
  // Samuel: "Die E-Mail geht raus, und es wird alles clean direkt geschlossen."
  // Bisher schlossen v16 UND v18 per location.href - ein kompletter Seiten-
  // Reload (weisses Aufblitzen, App laedt neu, fuehlt sich an wie 'refreshen
  // muessen'). Jetzt in dieser Reihenfolge, alles ohne Neuladen:
  //   1. Router-Link der App auf die Inbox anklicken (SPA-Navigation),
  //   2. sonst history.back(), wenn wir per Klick aus der Liste kamen,
  //   3. Notnagel wie frueher: harte Navigation.
  var lkKamAusListe = false;
  var lkLetzterPfad = location.pathname;
  setInterval(function () {
    var p = location.pathname;
    if (p === lkLetzterPfad) return;
    // Wechsel Liste -> Ticket gemerkt: dann fuehrt history.back() sicher zurueck.
    lkKamAusListe = /\/inbox$/.test(lkLetzterPfad) && /\/inbox\/[^/]+/.test(p);
    lkLetzterPfad = p;
  }, 300);
  function lkSanftZurListe() {
    var m = location.pathname.match(/\/workspace\/([^/]+)\/inbox\/[^/]+/);
    if (!m) return;
    var ziel = '/workspace/' + m[1] + '/inbox';
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var href = links[i].getAttribute('href') || '';
      if (href === ziel || href === ziel + '/') { links[i].click(); return; }
    }
    if (lkKamAusListe && history.length > 1) { history.back(); return; }
    location.href = ziel;
  }
  function zurueckZurListe() { lkSanftZurListe(); }
  var sendeLaeuft = false;
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!el) return;
    // Den Senden-Knopf am Text erkennen, nicht an Klassen (Memory-Regel).
    var btn = el.closest ? el.closest('button,[role="button"]') : null;
    if (!btn) return;
    if (!/^\s*(senden|send)\s*$/i.test(String(btn.textContent || ''))) return;   // v29: auch engl. Oberflaeche
    var id = currentTicketId();
    if (!id || sendeLaeuft) return;
    // SCHON-BEANTWORTET-SCHUTZ (v38, Samuels Bug 24.08.): In "Meine
    // Erstellten" ist JEDES Ticket bereits 'answered'. Der Poller unten
    // schloss die Ansicht deshalb 1,5 s nach jedem Senden-Klick - auch wenn
    // die App gar nichts abgeschickt hat (leerer Text, Validierung). Echte
    // Sends schliesst der fetch/XHR-Interceptor ohnehin in derselben
    // Millisekunde. Also: Ist das Ticket laut Cache schon beantwortet/geloest,
    // Poller und Toast komplett ueberspringen.
    try {
      var lst = __lkTicketCache.tickets || [];
      for (var li = 0; li < lst.length; li++) {
        if (String(lst[li].id) === String(id) || String(lst[li].ticket_number) === String(id)) {
          if (['answered', 'resolved', 'closed'].indexOf(String(lst[li].status || '')) >= 0) return;
          break;
        }
      }
    } catch (eSt) {}
    toast(lang === 'en' ? 'Sending…' : 'E-Mail wird gesendet…', true);
    sendeLaeuft = true;
    // Bis zu 12 Sekunden auf die Server-Bestätigung warten, dann aufgeben.
    var versuche = 0;
    var timer = setInterval(async function () {
      versuche++;
      if (await ticketIstBeantwortet(id)) {
        clearInterval(timer);
        sendeLaeuft = false;
        zurueckZurListe();
      } else if (versuche >= 20) {   // v17: 30 s statt 12 — Uebersetzungs-POSTs brauchen laenger
        clearInterval(timer);
        sendeLaeuft = false; // Versand offenbar fehlgeschlagen: Ansicht unverändert lassen
      }
    }, 1500);
  }, true);


  // ── 8) LISTEN-WAHRHEIT (v17, 11.08.) ─────────────────────────────────────
  // Samuels Bug: Gesendete Mails blieben im Posteingang stehen oder ploppten
  // wieder auf. Wurzel (Server, behoben): veraltete 304-Antworten nach dem
  // Versand. Dieses Modul ist das Sicherheitsnetz dahinter: Haengt die
  // React-Liste trotzdem einmal, wird sie hier gegen den Server abgeglichen —
  // ein Ticket, das laut Server beantwortet/geloest ist, wird im
  // POSTEINGANG-Ordner ausgeblendet. Selbstheilend nach dem v15-Muster
  // (erst alles wiederherstellen, dann neu entscheiden). Greift NUR im
  // Posteingang — in "Meine Erstellten"/"Geloest" sind beantwortete Tickets
  // richtig — und NUR mit frischen Serverdaten. Im Zweifel: nichts tun.
  function aktiverOrdnerName() {
    // NEUBAU (v39, Wurzel von Samuels "Meine Erstellten leert sich", 26.08.):
    // Die alte Erkennung nahm den ERSTEN Blatt-Knoten je Label im Dokument -
    // und das war fuer "Posteingang" der UNSICHTBARE Hover-Tooltip der
    // Icon-Hauptnavigation (span.hidden mit dunklem Hintergrund, w=0). Der
    // verdraengte per Dubletten-Filter den echten Ordner-Button und bildete
    // als einziges dunkles Element IMMER die 1er-Minderheit. Ergebnis: In
    // JEDEM Ordner meldete die Erkennung "Posteingang", und der Abgleich
    // blendete in "Meine Erstellten" alle (beantworteten) Karten aus.
    // Jetzt: nur echte, SICHTBARE Ordner-BUTTONs (Text = Label + Zaehler),
    // Hintergrund direkt vom Button; uebersetzte EN-Labels werden auf die
    // deutschen Namen normalisiert, damit alle Aufrufer weiter funktionieren.
    var map = {
      'Posteingang': 'Posteingang', 'Entwürfe': 'Entwürfe',
      'Meine Erstellten': 'Meine Erstellten', 'Gelöst': 'Gelöst', 'Spam': 'Spam',
      'Inbox': 'Posteingang', 'Drafts': 'Entwürfe',
      'Sent by me': 'Meine Erstellten', 'Resolved': 'Gelöst'
    };
    var re = /^(Posteingang|Entwürfe|Meine Erstellten|Gelöst|Spam|Inbox|Drafts|Sent by me|Resolved)\s*\d{0,5}$/;
    var found = [];
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (!b.offsetParent) continue;                          // unsichtbar (Tooltips etc.)
      var m = String(b.textContent || '').trim().match(re);
      if (!m) continue;
      var label = map[m[1]] || m[1];
      var dup = false;
      for (var f = 0; f < found.length; f++) if (found[f].label === label) { dup = true; break; }
      if (!dup) found.push({ label: label, el: b });
    }
    if (found.length < 3) return null;
    var groups = {};
    for (var g = 0; g < found.length; g++) {
      var bg = getComputedStyle(found[g].el).backgroundColor;
      (groups[bg] = groups[bg] || []).push(found[g]);
    }
    var keys = Object.keys(groups);
    if (keys.length !== 2) return null;                       // unklares Bild -> nichts tun
    var a = groups[keys[0]], b2 = groups[keys[1]];
    var minderheit = a.length < b2.length ? a : b2.length < a.length ? b2 : null;
    if (!minderheit || minderheit.length !== 1) return null;  // aktiv = genau EIN Eintrag
    return minderheit[0].label;
  }
  function nummernChipsIn(el) {
    var alle = el.querySelectorAll('span,div');
    var n = 0;
    for (var i = 0; i < alle.length; i++) {
      if (alle[i].childElementCount === 0 && /^#\d{3,5}$/.test(String(alle[i].textContent || '').trim())) n++;
      if (n > 1) return n;
    }
    return n;
  }
  function karteVon(chip) {
    // Vom Nummern-Chip zur ganzen Ticket-Karte: erste Ebene, deren Eltern-
    // Container mehrere karten-hohe Geschwister stapelt (die Ticketliste).
    // SCHUTZ (v37, Samuels Bug 24.08.): Wenn fast alle Karten schon versteckt
    // waren, kletterte die Suche zu hoch und versteckte die GANZE Listen-
    // Spalte (die dank React-Knoten-Wiederverwendung dann auch in anderen
    // Ordnern fehlte). Eine echte Karte enthaelt genau EINEN Nummern-Chip
    // und ist nie hoeher als ~400px - alles andere wird NIE angefasst.
    var el = chip;
    for (var k = 0; k < 8 && el && el.parentElement; k++) {
      var p = el.parentElement;
      var karten = 0;
      for (var c = 0; c < p.children.length; c++) if (p.children[c].offsetHeight > 70) karten++;
      if (karten >= 2 && el.offsetHeight > 70) {
        if (el.offsetHeight > 400) return null;
        if (nummernChipsIn(el) !== 1) return null;
        return el;
      }
      el = p;
    }
    return null;
  }
  async function listeAbgleichen() {
    // Selbstheilung zuerst: alles Versteckte wieder zeigen (v15-Muster)
    var weg = document.querySelectorAll('[data-lk-zeile-weg]');
    for (var i = 0; i < weg.length; i++) { weg[i].style.display = ''; weg[i].removeAttribute('data-lk-zeile-weg'); }
    if (aktiverOrdnerName() !== 'Posteingang') return;
    var list = await loadTicketCache();
    // ORDNER-RACE (v38, Samuels Bug 24.08. "Meine Erstellten klappt zu"):
    // Zwischen der Ordner-Pruefung oben und dem Ausblenden unten liegt ein
    // await (Server-Abruf, bis zu ein paar hundert ms). Klickte Samuel genau
    // in diesem Fenster von Posteingang auf "Meine Erstellten", wurde die
    // NEUE Liste ausgeblendet - und die besteht dort zu 100% aus beantworteten
    // Tickets, also leerte sich der komplette Ordner. Deshalb: nach dem
    // Warten noch einmal synchron pruefen, direkt vor dem Ausblenden.
    if (aktiverOrdnerName() !== 'Posteingang') return;
    if (!list || !list.length) return;
    var status = {};
    var schlaeft = {};
    for (var t = 0; t < list.length; t++) {
      if (list[t] && list[t].ticket_number != null) status[String(list[t].ticket_number)] = String(list[t].status || '');
      if (list[t] && list[t].ticket_number != null && list[t].snooze_until) schlaeft[String(list[t].ticket_number)] = true;
    }
    var nums = leafNodes('span,div', /^#\d{3,5}$/);
    for (var n = 0; n < nums.length; n++) {
      var chip = topmostSameText(nums[n]);
      var reihe = chip.parentElement;
      if (!reihe || reihe.id === 'lk-jump-box') continue;
      // Nur echte Listenzeilen (gleiche Schutzschranke wie das Entruempeln)
      if (reihe.children.length < 3 && !reihe.querySelector(':scope > .lk-conf')) continue;
      var nr = String(chip.textContent || '').trim().replace('#', '');
      var st = status[nr];
      var schlummert = !!schlaeft[nr];
      if (!schlummert && st !== 'answered' && st !== 'resolved' && st !== 'closed') continue;
      var karte = karteVon(chip);
      if (!karte) continue;
      karte.style.display = 'none';
      karte.setAttribute('data-lk-zeile-weg', '1');
      try { console.log('[lk] #' + nr + ' aus dem Posteingang ausgeblendet (' + (schlummert ? 'schlummert' : 'Server sagt: ' + st) + ')'); } catch (e) {}
    }
  }
  // SOFORT-WIEDERHERSTELLUNG BEIM ORDNERKLICK (v38): React verwendet die
  // Karten-Knoten beim Ordnerwechsel wieder - eine im Posteingang versteckte
  // Karte taucht sonst in "Meine Erstellten" als unsichtbare Zeile wieder auf,
  // bis der naechste Takt (bis 2,5 s) sie heilt. Beim Klick auf einen Ordner
  // werden deshalb ALLE versteckten Zeilen synchron wieder gezeigt, noch bevor
  // React neu rendert. Falsch sichtbare beantwortete Tickets im Posteingang
  // blendet der naechste Abgleich dann wieder korrekt aus - unsichtbare
  // richtige Tickets waeren das schlimmere Uebel.
  var LK_ORDNER_RE = /^(Posteingang|Entwürfe|Meine Erstellten|Gelöst|Spam|Inbox|Drafts|Sent by me|Resolved)\s*\d{0,5}$/;
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('button,a,[role="button"]') : null;
    if (!el) return;
    var tx = String(el.textContent || '').trim();
    if (!LK_ORDNER_RE.test(tx)) return;
    var weg = document.querySelectorAll('[data-lk-zeile-weg]');
    for (var i = 0; i < weg.length; i++) { weg[i].style.display = ''; weg[i].removeAttribute('data-lk-zeile-weg'); }
  }, true);
  // (Taktgeber weiter unten gebuendelt)


  // ── 8b) SOFORT SCHLIESSEN, WENN DER SERVER DEN VERSAND BESTAETIGT (v29) ──
  // Wurzel von Samuels "manchmal haengt es, manchmal muss ich refreshen":
  // v16/v18 warten aufs POLLING (Klick-Poller alle 1,5 s, Zustands-Waechter
  // alle 2,5 s, Cache-Frist 2,5 s) - zwischen Server-Bestaetigung und Schliessen
  // vergingen so bis zu ~5 s, und der Klick-Poller verfehlte Sondenfaelle
  // (React-Rerender, Enter statt Klick). Jetzt haengen wir uns an den Sende-
  // Request SELBST: Antwortet der Server mit Erfolg auf
  // POST /api/inbound/<id>/message, schliessen wir in derselben Millisekunde.
  // Fehlschlag => nichts schliessen, Fehlermeldung zeigen, Entwurf bleibt.
  function lkIstSendePfad(url, method) {
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    return /\/api\/inbound\/[^/]+\/message(\?|$)/.test(String(url || ''));
  }
  function lkIdAusSendePfad(url) {
    var m = String(url || '').match(/\/api\/inbound\/([^/]+)\/message/);
    return m ? m[1] : null;
  }
  function lkIstNotiz(body) {
    // Interne Notizen laufen ueber denselben Endpunkt - die schliessen nichts.
    try { return typeof body === 'string' && /"(direction)"\s*:\s*"note"|"is_internal_note"\s*:\s*true/.test(body); }
    catch (e) { return false; }
  }
  function lkCacheAlsBeantwortet(id) {
    try {
      var list = __lkTicketCache.tickets || [];
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id)) { list[i].status = 'answered'; break; }
      }
      __lkTicketCache.at = Date.now();   // Cache gilt als frisch: alle sehen sofort die Wahrheit
    } catch (e) {}
  }
  // SOFORT SCHLIESSEN (v29, Samuel 16.08.): "Manchmal clean, manchmal ruckelt
  // es und schliesst erst spaeter." Ursache: v29 wartete auf die Server-
  // Bestaetigung (Uebersetzung + SMTP = 1-4 s, je nach Mail unterschiedlich),
  // daher das uneinheitliche Gefuehl. Jetzt schliesst die Ansicht in dem
  // Moment, in dem der Sende-Request STARTET. Schlaegt der Versand fehl, holt
  // der Rollback das Ticket sichtbar zurueck und meldet es laut - der Entwurf
  // bleibt serverseitig sowieso erhalten.
  function lkOptimistisch(id) {
    try { console.log('[lk] Senden gestartet fuer ' + id + ', Ansicht schliesst sofort'); } catch (e) {}
    // v38: Rueckmeldung hier statt nur am Klick - so kommt sie genau dann,
    // wenn wirklich ein Sende-Request laeuft (auch bei bereits beantworteten
    // Tickets, wo der Klick-Poller uebersprungen wird).
    try { toast(lang === 'en' ? 'Sending…' : 'E-Mail wird gesendet…', true); } catch (e) {}
    lkCacheAlsBeantwortet(id)
    lkAnsicht = { id: null, warOffen: false }
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/([^/]+)/)
    if (m && String(m[1]) === String(id)) lkSanftZurListe()
    setTimeout(function () { try { listeAbgleichen(); } catch (e) {} }, 120)
  }
  function lkVersandRueckgaengig(id) {
    try { console.warn('[lk] Versand fehlgeschlagen, Ticket ' + id + ' kommt zurueck in die Liste'); } catch (e) {}
    __lkTicketCache.at = 0
    try { lkTakt(); } catch (e) {}
  }
  function lkNachVersand(id) {
    try { console.log('[lk] Versand bestaetigt fuer ' + id); } catch (e) {}
    try { toast(lang === 'en' ? 'Sent' : 'Gesendet ✓', true); } catch (e) {}
    lkCacheAlsBeantwortet(id);
    sendeLaeuft = false;                  // v16-Poller abruesten, er wird nicht mehr gebraucht
    lkAnsicht = { id: null, warOffen: false };
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/([^/]+)/);
    if (m && String(m[1]) === String(id)) lkSanftZurListe();
    setTimeout(function () { try { listeAbgleichen(); } catch (e) {} }, 120);
    setTimeout(function () { __lkTicketCache.at = 0; lkTakt(); }, 1500);   // danach einmal echte Server-Wahrheit holen
  }
  function lkVersandFehler(id, status) {
    try { console.warn('[lk] Versand fehlgeschlagen fuer ' + id + ' (HTTP ' + status + ')'); } catch (e) {}
    toast(lang === 'en' ? 'Sending failed - your draft is untouched.' : 'Senden fehlgeschlagen. Das Ticket ist zurück im Posteingang, der Entwurf ist unverändert.', false);
  }
  // fetch-Weg (falls die App fetch nutzt):
  // FRUEHERE GESPRAECHE (v32, Wunsch aus dem Team 23.08.): Hat dieselbe Kundin
  // (gleiche E-Mail) schon andere Tickets, zeigt ein Chip unten rechts am
  // Ticket "N fruehere Gespraeche" - aufklappbar mit Direktsprung. Eigenes
  // Element, fest positioniert (Memory-Regel: nie am App-DOM ankern).
  var __lkVerwandteNr = null;
  function lkVerwandteEntfernen() {
    var e = document.getElementById('lk-verwandte');
    if (e) e.remove();
  }
  function lkVerwandteAktualisieren() {
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/([^/]+)$/);
    var nr = m ? m[1] : null;
    if (!nr) { __lkVerwandteNr = null; lkVerwandteEntfernen(); return; }
    if (nr === __lkVerwandteNr) return;
    __lkVerwandteNr = nr;
    lkVerwandteEntfernen();
    fetch('/api/inbound/' + encodeURIComponent(nr) + '/related', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.related || !d.related.length) return;
        if (__lkVerwandteNr !== nr) return;   // inzwischen weiternavigiert
        lkVerwandteRendern(d.related);
      })
      .catch(function () {});
  }
  function lkVerwandteRendern(liste) {
    lkVerwandteEntfernen();
    var ws = (location.pathname.match(/\/workspace\/([^/]+)\//) || [])[1];
    if (!ws) return;
    var statusDe = { open: 'Offen', new: 'Neu', pending: 'Offen', answered: 'Beantwortet', resolved: 'Gel\u00f6st', closed: 'Gel\u00f6st', draft: 'Entwurf' };
    var statusEn = { open: 'Open', new: 'New', pending: 'Open', answered: 'Answered', resolved: 'Resolved', closed: 'Resolved', draft: 'Draft' };
    var box = document.createElement('div');
    box.id = 'lk-verwandte';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;font:600 12.5px/1.4 system-ui,sans-serif;';
    var n = liste.length;
    var pill = document.createElement('button');
    pill.type = 'button';
    var vLabel = (lang === 'en'
      ? (n + (n === 1 ? ' previous conversation' : ' previous conversations'))
      : (n + (n === 1 ? ' fr\u00fcheres Gespr\u00e4ch' : ' fr\u00fchere Gespr\u00e4che')));
    pill.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg><span>' + vLabel + '</span>';
    pill.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:9px 15px;' +
      'background:#fff;color:#1E4D2B;border:1.5px solid #2E7D32;font:700 13px/1.2 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.18);';
    var panel = document.createElement('div');
    panel.style.cssText = 'display:none;position:absolute;right:0;bottom:calc(100% + 8px);width:330px;' +
      'max-height:330px;overflow:auto;background:#fff;border:1px solid #d5e3d8;border-radius:12px;' +
      'box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;text-align:left;';
    for (var i = 0; i < liste.length; i++) {
      (function (t) {
        var item = document.createElement('button');
        item.type = 'button';
        var datum = '';
        try {
          if (t.received_at) datum = new Date(t.received_at).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
        } catch (e) {}
        var st = (lang === 'en' ? statusEn : statusDe)[String(t.status)] || String(t.status || '');
        if (t.is_spam) st = 'Spam';
        var kopf = document.createElement('div');
        kopf.textContent = '#' + t.ticket_number + '  \u00b7  ' + datum + '  \u00b7  ' + st;
        kopf.style.cssText = 'font-weight:800;color:#1E4D2B;';
        var betreff = document.createElement('div');
        betreff.textContent = String(t.subject || '').slice(0, 90);
        betreff.style.cssText = 'font-weight:500;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        item.appendChild(kopf);
        item.appendChild(betreff);
        item.style.cssText = 'display:block;width:100%;box-sizing:border-box;cursor:pointer;border:none;' +
          'background:transparent;text-align:left;padding:8px 10px;border-radius:9px;font:inherit;';
        item.onmouseenter = function () { item.style.background = '#E8F3E9'; };
        item.onmouseleave = function () { item.style.background = 'transparent'; };
        item.onclick = function () { location.href = '/workspace/' + ws + '/inbox/' + t.ticket_number; };
        panel.appendChild(item);
      })(liste[i]);
    }
    pill.onclick = function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
    box.appendChild(panel);
    box.appendChild(pill);
    document.body.appendChild(box);
  }
  // SNOOZE (v35, Wunsch aus dem Team 23.08.): Knopf am Ticket, Auswahl 4h/24h/2d/7d,
  // Ticket verschwindet aus dem Posteingang und kommt automatisch zurueck.
  // Kundenantwort weckt es sofort (serverseitig). Eigenes Element, fest
  // positioniert - nie am App-DOM ankern (Memory-Regel).
  var __lkSnoozeNr = null;
  function lkSnoozeEntfernen() {
    var e = document.getElementById('lk-snooze');
    if (e) e.remove();
  }
  function lkSnoozeStand(nr) {
    var list = (__lkConf && __lkConf.schlummer) || {};
    return list[String(nr)] || null;
  }
  function lkSnoozeAktualisieren() {
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/([^/]+)$/);
    var nr = m ? m[1] : null;
    if (!nr) { __lkSnoozeNr = null; lkSnoozeEntfernen(); return; }
    if (nr === __lkSnoozeNr && document.getElementById('lk-snooze')) return;
    __lkSnoozeNr = nr;
    lkSnoozeRendern(nr);
  }
  function lkSnoozeZeit(iso) {
    try {
      return new Date(iso).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE',
        { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }
  function lkSnoozeRendern(nr) {
    lkSnoozeEntfernen();
    var box = document.createElement('div');
    box.id = 'lk-snooze';
    box.style.cssText = 'position:fixed;right:16px;bottom:62px;z-index:2147483001;font:600 12.5px/1.4 system-ui,sans-serif;';
    var bis = lkSnoozeStand(nr);
    var pill = document.createElement('button');
    pill.type = 'button';
    var sIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    var sLabel = bis
      ? ((lang === 'en' ? 'Snoozed until ' : 'Schlummert bis ') + lkSnoozeZeit(bis))
      : (lang === 'en' ? 'Snooze' : 'Sp\u00e4ter');
    pill.innerHTML = sIcon + '<span>' + sLabel + '</span>';
    pill.title = lang === 'en'
      ? 'Snooze this ticket: it leaves the inbox and comes back automatically. A customer reply wakes it immediately.'
      : 'Ticket schlummern lassen: Es verl\u00e4sst den Posteingang und kommt automatisch zur\u00fcck. Eine Kundenantwort weckt es sofort.';
    pill.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:9px 15px;' +
      'font:700 13px/1.2 system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.18);' +
      (bis ? 'background:#FFF8E1;color:#8a6d00;border:1.5px solid #C9A227;'
           : 'background:#fff;color:#1E4D2B;border:1.5px solid #2E7D32;');
    var panel = document.createElement('div');
    panel.style.cssText = 'display:none;position:absolute;right:0;bottom:calc(100% + 8px);width:240px;' +
      'background:#fff;border:1px solid #d5e3d8;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;text-align:left;';
    function eintrag(text, fett, onClick) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText = 'display:block;width:100%;box-sizing:border-box;cursor:pointer;border:none;background:transparent;' +
        'text-align:left;padding:9px 10px;border-radius:9px;font:inherit;' + (fett ? 'font-weight:800;color:#1E4D2B;' : 'font-weight:600;color:#374151;');
      b.onmouseenter = function () { b.style.background = '#E8F3E9'; };
      b.onmouseleave = function () { b.style.background = 'transparent'; };
      b.onclick = onClick;
      return b;
    }
    function setzen(stunden, labelText) {
      fetch('/api/inbound/' + encodeURIComponent(nr) + '/snooze', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours: stunden }),
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d) { toast(lang === 'en' ? 'Snooze failed' : 'Snooze fehlgeschlagen', false); return; }
        __lkConf.schlummer = __lkConf.schlummer || {};
        if (d.snooze_until) {
          __lkConf.schlummer[String(nr)] = d.snooze_until;
          toast((lang === 'en' ? 'Snoozed until ' : 'Schlummert bis ') + lkSnoozeZeit(d.snooze_until) + ' \u2713', true);
          lkSanftZurListe();
        } else {
          delete __lkConf.schlummer[String(nr)];
          toast(lang === 'en' ? 'Ticket is awake again \u2713' : 'Ticket ist wieder wach \u2713', true);
        }
        __lkTicketCache.at = 0;
        __lkSnoozeNr = null;
        lkSnoozeAktualisieren();
      }).catch(function () { toast(lang === 'en' ? 'Snooze failed' : 'Snooze fehlgeschlagen', false); });
    }
    if (bis) {
      var info = document.createElement('div');
      info.textContent = (lang === 'en' ? 'Snoozed until ' : 'Schlummert bis ') + lkSnoozeZeit(bis);
      info.style.cssText = 'padding:9px 10px;font-weight:800;color:#8a6d00;';
      panel.appendChild(info);
      panel.appendChild(eintrag(lang === 'en' ? '\u23F0 Wake up now' : '\u23F0 Jetzt aufwecken', true, function () { setzen(0); }));
    } else {
      var presets = lang === 'en'
        ? [[4, '4 hours'], [24, '24 hours'], [48, '2 days'], [168, '7 days']]
        : [[4, '4 Stunden'], [24, '24 Stunden'], [48, '2 Tage'], [168, '7 Tage']];
      for (var i = 0; i < presets.length; i++) {
        (function (pr) { panel.appendChild(eintrag(pr[1], false, function () { setzen(pr[0]); })); })(presets[i]);
      }
    }
    pill.onclick = function () {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    };
    box.appendChild(panel);
    box.appendChild(pill);
    document.body.appendChild(box);
  }
  setInterval(function () { try { lkVerwandteAktualisieren(); } catch (e) {} }, 700);
  setInterval(function () { try { lkSnoozeAktualisieren(); } catch (e) {} }, 900);

  // AUTO-SAVE ENTWURF (v31, Samuel 22.08.): Die App persistiert bearbeiteten
  // Entwurfstext nirgends - Text im Ticket-Editor ging beim Navigieren verloren
  // (#2059/#2060). Wir speichern den Editor-Stand debounced (900 ms) ueber den
  // neuen Endpunkt POST /api/inbound/<nr>/draft. Erkennung ueber den
  // Platzhalter des Antwort-Editors, damit Notizen etc. nie angefasst werden.
  var __lkDraftTimer = null;
  var __lkDraftLetzter = null;
  function lkTicketNrAusUrl() {
    var m = location.pathname.match(/\/inbox\/(\d+)/);
    return m ? m[1] : null;
  }
  function lkDraftSaveAbbrechen() {
    if (__lkDraftTimer) { clearTimeout(__lkDraftTimer); __lkDraftTimer = null; }
  }
  document.addEventListener('input', function (ev) {
    var el = ev.target;
    if (!el || el.tagName !== 'TEXTAREA') return;
    var ph = String(el.getAttribute('placeholder') || '');
    if (!/^(Antwort an |Reply to |Write a reply)/.test(ph)) return;
    var nr = lkTicketNrAusUrl();
    if (!nr) return;
    var wert = el.value;
    lkDraftSaveAbbrechen();
    __lkDraftTimer = setTimeout(function () {
      __lkDraftTimer = null;
      if (wert === __lkDraftLetzter) return;
      __lkDraftLetzter = wert;
      fetch('/api/inbound/' + nr + '/draft', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: wert }),
      }).catch(function () {});
    }, 900);
  }, true);

  var lkEchtesFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '';
    var method = (init && init.method) || (input && input.method) || 'GET';
    var body = init && typeof init.body === 'string' ? init.body : null;
    var istSenden = lkIstSendePfad(url, method) && !lkIstNotiz(body);
    var p = lkEchtesFetch.apply(this, arguments);
    if (istSenden) {
      var id = lkIdAusSendePfad(url);
      lkDraftSaveAbbrechen();
      lkOptimistisch(id);
      p.then(function (r) {
        if (r && r.ok) lkNachVersand(id);
        else if (r) { lkVersandRueckgaengig(id); lkVersandFehler(id, r.status); }
      }).catch(function () { lkVersandRueckgaengig(id); lkVersandFehler(id, 'Netzwerk'); });
    }
    return p;
  };
  // XHR-Weg (falls die App axios/XMLHttpRequest nutzt):
  (function () {
    var openAlt = XMLHttpRequest.prototype.open;
    var sendAlt = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__lkSenden = lkIstSendePfad(url, method);
      this.__lkSendeId = this.__lkSenden ? lkIdAusSendePfad(url) : null;
      return openAlt.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__lkSenden && lkIstNotiz(typeof body === 'string' ? body : null)) this.__lkSenden = false;
      if (this.__lkSenden) {
        var xhr = this;
        lkDraftSaveAbbrechen();
        lkOptimistisch(xhr.__lkSendeId);
        xhr.addEventListener('loadend', function () {
          if (xhr.status >= 200 && xhr.status < 300) lkNachVersand(xhr.__lkSendeId);
          else { lkVersandRueckgaengig(xhr.__lkSendeId); lkVersandFehler(xhr.__lkSendeId, xhr.status || 'Netzwerk'); }
        });
      }
      return sendAlt.apply(this, arguments);
    };
  })();

  // ── 9) LESEANSICHT NACH DEM SENDEN SCHLIESSEN (v18, 14.08.) ──────────────
  // Samuel: "Wenn ich eine E-Mail abschicke, bleibt die Chatansicht offen. Ich
  // brauche Uebersicht." Bisher hing das am Abfangen des Senden-Klicks (v16/v17)
  // und war deshalb fragil: anderer Button, Tastatur, React-Rerender - schon
  // greift es nicht. Jetzt zustandsbasiert statt klickbasiert:
  //   Beim Oeffnen eines Tickets merken wir uns seinen Status. Wechselt er,
  //   WAEHREND wir draufschauen, von offen auf beantwortet/geloest, springen wir
  //   zurueck in die Liste. Egal wodurch der Wechsel ausgeloest wurde.
  // Ein bewusst geoeffnetes, bereits beantwortetes Ticket wird NICHT geschlossen,
  // weil dort kein Uebergang stattfindet - Nachlesen bleibt jederzeit moeglich.
  var lkAnsicht = { id: null, warOffen: false };

  function lkTicketIdAusUrl() {
    var m = location.pathname.match(/\/workspace\/[^/]+\/inbox\/(\d+)/);
    return m ? m[1] : null;
  }
  function lkZurListe() { lkSanftZurListe(); }   // v29: ohne Seiten-Reload
  async function lkStatusVon(id) {
    try {
      var list = await loadTicketCache();   // geteilter Abruf, kein eigener mehr
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(id) || String(list[i].ticket_number) === String(id)) {
          return String(list[i].status || '');
        }
      }
    } catch (e) {}
    return null;
  }
  async function lkAnsichtPruefen() {
    var id = lkTicketIdAusUrl();
    if (!id) { lkAnsicht = { id: null, warOffen: false }; return; }

    var status = await lkStatusVon(id);
    if (status == null) return;
    var offen = ['open', 'new', 'pending', 'draft'].indexOf(status) >= 0;

    // Neues Ticket geoeffnet: Ausgangszustand merken, nichts tun.
    if (lkAnsicht.id !== id) {
      lkAnsicht = { id: id, warOffen: offen };
      return;
    }
    // Uebergang offen -> beantwortet, waehrend wir draufschauen: Ansicht schliessen.
    if (lkAnsicht.warOffen && !offen) {
      try { console.log('[lk] #' + id + ' wurde beantwortet, Leseansicht wird geschlossen'); } catch (e) {}
      lkAnsicht = { id: null, warOffen: false };
      lkZurListe();
    }
  }
  // EIN Taktgeber fuer alle Zusatzfunktionen. Beide Aufgaben teilen sich denselben
  // Abruf, laufen nacheinander und nur, wenn der Tab sichtbar ist. Ein Tab im
  // Hintergrund erzeugt damit gar keine Last mehr.
  async function lkTakt() {
    if (document.hidden) return;
    try { await lkAnsichtPruefen(); } catch (e) {}
    try { await listeAbgleichen(); } catch (e) {}
  }
  setInterval(function () { lkTakt(); }, 2500);
  lkTakt();

  // ── Kopiert-Rueckmeldung (v29) ─────────────────────────────────────────
  function lkKopiertToast(x, y) {
    var t = document.createElement('div');
    t.textContent = 'Kopiert \u2713';
    t.style.cssText = [
      'position:fixed', 'left:' + Math.round(x) + 'px', 'top:' + Math.round(y - 34) + 'px',
      'transform:translate(-50%,0)', 'z-index:2147483647', 'pointer-events:none',
      'background:#2e6b3a', 'color:#fff', 'font:600 12px system-ui,-apple-system,sans-serif',
      'padding:4px 10px', 'border-radius:999px', 'box-shadow:0 4px 14px rgba(15,60,20,.25)',
      'opacity:0', 'transition:opacity .15s ease, top .5s ease'
    ].join(';');
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.style.opacity = '1'; t.style.top = Math.round(y - 46) + 'px'; });
    setTimeout(function () { t.style.opacity = '0'; }, 750);
    setTimeout(function () { t.remove(); }, 1100);
  }
  var EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest ? e.target.closest('button, [role="button"]') : null;
    if (!btn) return;
    if (String(btn.textContent || '').trim().length > 2) return; // nur Icon-Knoepfe
    // Naehere Umgebung (bis 3 Ebenen) muss eine E-Mail-Adresse zeigen:
    var wrap = btn, hit = false;
    for (var i = 0; i < 3 && wrap; i++) {
      wrap = wrap.parentElement;
      var txt = wrap ? String(wrap.textContent || '').slice(0, 400) : '';
      if (wrap && EMAIL_RE.test(txt)) { hit = true; break; }
    }
    if (!hit) return;
    var r = btn.getBoundingClientRect();
    lkKopiertToast(r.left + r.width / 2, r.top);
  }, true);

  // SUCHFELD-SPRUNG (v29, Samuel 20.08.): Die App-Suche filtert nur Name/
  // Betreff/E-Mail, nicht die Ticketnummer - eingegebene '#1665' liefert 'Keine
  // Tickets'. Fix: An das vorhandene Suchfeld (Platzhalter 'Suchen') haengen
  // wir einen Enter-Listener, der bei einer Ticketnummer (mit oder ohne #)
  // direkt in das Ticket springt. Keine neue UI, kein Reload. jumpToTicket
  // gibt es schon aus der alten Sprungbox.
  function lkFindeSuchfeld() {
    var inputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]');
    for (var i = 0; i < inputs.length; i++) {
      var ph = String(inputs[i].getAttribute('placeholder') || '').toLowerCase();
      if (ph.indexOf('such') >= 0 || ph.indexOf('search') >= 0) return inputs[i];
    }
    return null;
  }
  function lkSuchfeldVerdrahten() {
    var inp = lkFindeSuchfeld();
    if (!inp || inp.__lkVerdrahtet) return;
    inp.__lkVerdrahtet = true;
    function anStelle(v) {
      if (!/^\d{3,6}$/.test(v)) return false;
      try { toast(lang === 'en' ? ('Jumping to #' + v) : ('Springe zu #' + v), true); } catch (_) {}
      jumpToTicket(v);
      return true;
    }
    // Alle drei Ebenen abfangen, capture=true und stopImmediatePropagation:
    // die App könnte Enter selbst hören und uns überholen.
    ['keydown', 'keypress', 'keyup'].forEach(function (ev) {
      inp.addEventListener(ev, function (e) {
        if (e.key !== 'Enter' && e.keyCode !== 13) return;
        var v = String(inp.value || '').trim().replace(/^#/, '');
        if (!/^\d{3,6}$/.test(v)) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
        if (ev === 'keydown') anStelle(v);
      }, true);
    });
  }
  setInterval(lkSuchfeldVerdrahten, 800);
  lkSuchfeldVerdrahten();


  // ── VOLLTEXT-SUCHE UEBER ALLES (v40, Samuel 30.08.) ──────────────────────
  // Samuel suchte "#S10013" und bekam "Keine Tickets in diesem Ordner", obwohl
  // das Ticket existierte: Die App-Suche filtert nur die 500 geladenen Tickets
  // und nur ueber Betreff/Name/E-Mail/Ticketnummer. Eine BESTELLNUMMER steht
  // aber im Mailtext. Dazu kam: Alles aelter als ~5 Tage war serverseitig
  // geloescht. Beides ist behoben (Archiv + /api/suche); hier haengt die
  // Oberflaeche dran. Eigenes, fest positioniertes Panel - nie am App-DOM
  // ankern (Memory-Regel).
  var __lkSuchTimer = null, __lkSuchLetzte = '', __lkSuchLauf = 0;
  function lkSuchPanel() {
    var p = document.getElementById('lk-suche');
    if (p) return p;
    p = document.createElement('div');
    p.id = 'lk-suche';
    p.style.cssText = 'position:fixed;left:236px;top:96px;width:540px;max-height:72vh;overflow:auto;' +
      'z-index:2147483400;background:#fff;border:1px solid #d5e3d8;border-radius:14px;' +
      'box-shadow:0 18px 46px rgba(0,0,0,.22);padding:8px;font:13px/1.45 system-ui,sans-serif;display:none;';
    document.body.appendChild(p);
    return p;
  }
  function lkSuchSchliessen() {
    var p = document.getElementById('lk-suche');
    if (p) p.style.display = 'none';
  }
  function lkEsc(t) {
    return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function lkDatum(iso) {
    try {
      return new Date(iso).toLocaleDateString(lang === 'en' ? 'en-GB' : 'de-DE',
        { day: '2-digit', month: '2-digit', year: '2-digit' });
    } catch (e) { return ''; }
  }
  function lkSuchRendern(d, q) {
    var p = lkSuchPanel();
    p.innerHTML = '';
    var kopf = document.createElement('div');
    kopf.style.cssText = 'padding:6px 10px 8px;font-weight:800;color:#1E4D2B;border-bottom:1px solid #eef3ef;margin-bottom:4px;';
    var n = d.gesamt || 0;
    kopf.textContent = lang === 'en'
      ? (n + (n === 1 ? ' hit' : ' hits') + ' for "' + q + '" (' + (d.durchsucht || 0) + ' searched)')
      : (n + (n === 1 ? ' Treffer' : ' Treffer') + ' für "' + q + '" (' + (d.durchsucht || 0) + ' durchsucht)');
    p.appendChild(kopf);
    if (!n) {
      var leer = document.createElement('div');
      leer.style.cssText = 'padding:14px 10px;color:#6b7280;';
      leer.textContent = lang === 'en' ? 'Nothing found, not even in the archive.' : 'Nichts gefunden, auch nicht im Archiv.';
      p.appendChild(leer);
      p.style.display = 'block';
      return;
    }
    (d.treffer || []).forEach(function (t) {
      var row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:left;border:none;' +
        'background:transparent;cursor:pointer;padding:8px 10px;border-radius:9px;font:inherit;';
      row.onmouseenter = function () { row.style.background = '#E8F3E9'; };
      row.onmouseleave = function () { row.style.background = 'transparent'; };
      var marke = t.archiviert
        ? '<span style="background:#eef1f5;color:#41506b;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:800">' +
          (lang === 'en' ? 'ARCHIVE' : 'ARCHIV') + '</span>'
        : '';
      var nr = t.ticket_number
        ? '#' + lkEsc(t.ticket_number)
        : '<span style="color:#6b7280">' + (lang === 'en' ? 'archived mail' : 'Archivmail') + '</span>';
      row.innerHTML =
        '<div style="display:flex;gap:7px;align-items:center;font-weight:800;color:#1E4D2B">' +
          '<span>' + nr + '</span>' + marke +
          '<span style="margin-left:auto;font-weight:600;color:#6b7280;font-size:12px">' + lkEsc(lkDatum(t.received_at)) + '</span>' +
        '</div>' +
        '<div style="font-weight:600;color:#111;margin-top:1px">' + lkEsc((t.customer_name || t.customer_email || '')) + '</div>' +
        '<div style="color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + lkEsc(t.subject) + '</div>' +
        '<div style="color:#6b7280;font-size:12px;margin-top:2px">' + lkEsc(t.fundstelle) + '</div>';
      row.onclick = function () {
        lkSuchSchliessen();
        if (!t.archiviert && t.ticket_number) {
          var m = location.pathname.match(/\/workspace\/([^/]+)/);
          if (m) { location.href = '/workspace/' + m[1] + '/inbox/' + t.ticket_number; return; }
        }
        lkArchivOeffnen(t.ticket_number || t.archiv_id);
      };
      p.appendChild(row);
    });
    p.style.display = 'block';
  }
  // Leseansicht fuer archivierte Vorgaenge: Die App kennt nur die geladenen
  // Tickets, ein Archiv-Ticket wuerde dort "Kein Ticket ausgewaehlt" zeigen.
  // Deshalb rendern wir es selbst, bewusst NUR lesend.
  function lkArchivOeffnen(key) {
    var alt = document.getElementById('lk-archiv');
    if (alt) alt.remove();
    var hg = document.createElement('div');
    hg.id = 'lk-archiv';
    hg.style.cssText = 'position:fixed;inset:0;z-index:2147483500;background:rgba(15,25,20,.42);' +
      'display:flex;align-items:center;justify-content:center;padding:34px;';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:16px;max-width:820px;width:100%;max-height:86vh;' +
      'overflow:auto;padding:22px 24px;font:14px/1.55 system-ui,sans-serif;box-shadow:0 24px 60px rgba(0,0,0,.3);';
    box.innerHTML = '<div style="color:#6b7280">' + (lang === 'en' ? 'Loading…' : 'Wird geladen…') + '</div>';
    hg.appendChild(box);
    hg.onclick = function (e) { if (e.target === hg) hg.remove(); };
    document.body.appendChild(hg);
    fetch('/api/archiv/' + encodeURIComponent(key), { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.ticket) { box.innerHTML = '<div>' + (lang === 'en' ? 'Not found in the archive.' : 'Nicht im Archiv gefunden.') + '</div>'; return; }
        var t = d.ticket;
        var h = '<div style="display:flex;align-items:flex-start;gap:12px;border-bottom:1px solid #eef3ef;padding-bottom:12px;margin-bottom:14px">' +
          '<div><div style="font-weight:800;font-size:17px;color:#1E4D2B">' + lkEsc(t.subject || '(Kein Betreff)') + '</div>' +
          '<div style="color:#374151;margin-top:2px">' + lkEsc(t.customer_name || '') + ' &lt;' + lkEsc(t.customer_email || '') + '&gt;</div>' +
          '<div style="color:#6b7280;font-size:12.5px;margin-top:2px">' +
            (t.ticket_number ? '#' + lkEsc(t.ticket_number) + ' · ' : '') +
            lkEsc(lkDatum(t.received_at)) + ' · ' +
            (lang === 'en' ? 'archived, read only' : 'archiviert, nur lesbar') +
          '</div></div>' +
          '<button id="lk-archiv-zu" style="margin-left:auto;cursor:pointer;border:1px solid #d5e3d8;background:#fff;' +
          'border-radius:9px;padding:6px 12px;font:inherit;font-weight:700">' + (lang === 'en' ? 'Close' : 'Schließen') + '</button></div>';
        var msgs = (t.messages || []).filter(function (m) { return String(m.body_text || '').trim(); });
        if (!msgs.length && String(t.body_text || '').trim()) {
          msgs = [{ direction: 'in', body_text: t.body_text, created_at: t.received_at }];
        }
        msgs.forEach(function (m) {
          var raus = m.direction === 'out';
          h += '<div style="margin-bottom:12px;padding:11px 13px;border-radius:11px;' +
            (raus ? 'background:#eef6f1;border:1px solid #d9ece1' : 'background:#f7f8f9;border:1px solid #e9ecef') + '">' +
            '<div style="font-weight:800;color:' + (raus ? '#1E4D2B' : '#374151') + ';font-size:12.5px;margin-bottom:4px">' +
            (raus ? 'Barbara' : lkEsc(m.from_name || t.customer_name || (lang === 'en' ? 'Customer' : 'Kundin'))) +
            ' · ' + lkEsc(lkDatum(m.created_at)) + (m.is_internal_note ? ' · ' + (lang === 'en' ? 'internal note' : 'interne Notiz') : '') + '</div>' +
            '<div style="white-space:pre-wrap;color:#111">' + lkEsc(String(m.body_text || '').slice(0, 6000)) + '</div></div>';
        });
        box.innerHTML = h;
        var zu = document.getElementById('lk-archiv-zu');
        if (zu) zu.onclick = function () { hg.remove(); };
      })
      .catch(function () { box.innerHTML = '<div>' + (lang === 'en' ? 'Loading failed.' : 'Laden fehlgeschlagen.') + '</div>'; });
  }
  function lkSuchAbfragen(q) {
    var lauf = ++__lkSuchLauf;
    fetch('/api/suche?q=' + encodeURIComponent(q) + '&limit=60', { credentials: 'include' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || lauf !== __lkSuchLauf) return;   // veraltete Antwort verwerfen
        lkSuchRendern(d, q);
      })
      .catch(function () {});
  }
  function lkSucheVerdrahten() {
    var inp = lkFindeSuchfeld();
    if (!inp || inp.__lkSuchGebunden) return;
    inp.__lkSuchGebunden = true;
    function tippen() {
      var q = String(inp.value || '').trim();
      if (__lkSuchTimer) clearTimeout(__lkSuchTimer);
      if (q.length < 2) { lkSuchSchliessen(); __lkSuchLetzte = ''; return; }
      __lkSuchTimer = setTimeout(function () {
        if (q === __lkSuchLetzte) return;
        __lkSuchLetzte = q;
        lkSuchAbfragen(q);
      }, 320);
    }
    inp.addEventListener('input', tippen);
    inp.addEventListener('focus', tippen);
  }
  setInterval(lkSucheVerdrahten, 900);
  lkSucheVerdrahten();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { lkSuchSchliessen(); var a = document.getElementById('lk-archiv'); if (a) a.remove(); }
  });
  document.addEventListener('mousedown', function (e) {
    var p = document.getElementById('lk-suche');
    if (!p || p.style.display === 'none') return;
    if (p.contains(e.target)) return;
    var inp = lkFindeSuchfeld();
    if (inp && (e.target === inp || inp.contains(e.target))) return;
    lkSuchSchliessen();
  }, true);

  setTimeout(ensureJumpBox, 400);
  setTimeout(scheduleDeclutter, 600);
  // PERSONALISIERUNG (v31, Samuel 22.08.): Die App zeigt fest verbaute
  // Initialen/Namen aus der Build-Zeit ('SA' / 'Sam'). Fuer Mitarbeiterinnen
  // muss der eigene Name erscheinen: a) kleine Avatar-Elemente mit exakt 'SA'
  // -> echte Initialen, b) das Wort 'Sam' in Ueberschriften -> echter Name.
  // Nur aktiv, wenn der eingeloggte User NICHT Sam ist.
  function lkPersonalisieren() {
    if (!lkUserName || lkUserName === 'Sam') return;
    var initialen = lkUserName.slice(0, 2).toUpperCase();
    var kandidaten = document.querySelectorAll('button, div, span, a');
    for (var i = 0; i < kandidaten.length; i++) {
      var el = kandidaten[i];
      if (el.children.length === 0 && el.offsetWidth > 0 && el.offsetWidth <= 64
          && String(el.textContent || '').trim() === 'SA') {
        // NIE textContent setzen (v45, 16.09.2026): das wirft Reacts eigene
        // Textknoten weg. Hat das Element mehrere Textkinder, findet React sie
        // beim naechsten Zeichnen nicht mehr und stuerzt mit NotFoundError ab.
        // Denselben Knoten behalten und nur seinen Wert aendern ist unkritisch.
        var tn = el.firstChild;
        if (tn && tn.nodeType === 3 && el.childNodes.length === 1) {
          if (tn.nodeValue !== initialen) tn.nodeValue = initialen;
        }
      }
    }
    var koepfe = document.querySelectorAll('h1, h2, h3');
    for (var k = 0; k < koepfe.length; k++) {
      var h = koepfe[k];
      if (!/\bSam\b/.test(String(h.textContent || ''))) continue;
      for (var c = 0; c < h.childNodes.length; c++) {
        var kn = h.childNodes[c];
        if (kn.nodeType === 3 && /\bSam\b/.test(kn.nodeValue)) {
          kn.nodeValue = kn.nodeValue.replace(/\bSam\b/g, lkUserName);
        }
      }
    }
  }
  var __lkPersGeplant = null;
  function schedulePersonalisieren() {
    if (__lkPersGeplant) return;
    __lkPersGeplant = setTimeout(function () {
      __lkPersGeplant = null;
      try { lkPersonalisieren(); } catch (e) {}
    }, 80);
  }

  // I18N-WÄCHTER (v29, 21.08.): applyLang bei jeder DOM-Aenderung neu triggern,
  // damit React-Rerenders keine deutschen Textknoten zurueckbringen.
  new MutationObserver(function () { ensureJumpBox(); scheduleDeclutter(); if (typeof scheduleApplyLang === 'function' && lang === 'en') scheduleApplyLang(); schedulePersonalisieren(); }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // ── 20) STOERUNGSBALKEN (v44, 15.09.2026) ─────────────────────────────────
  // Am 15.09. war das KI-Guthaben 24 Stunden lang leer. Das Tool sah voellig
  // normal aus, es kamen nur keine Entwuerfe und keine Uebersetzungen mehr.
  // Mitarbeiterin A hat einen ganzen Arbeitstag gerätselt, Sam hat es erst abends
  // erfahren. Dieser Balken macht so eine Stoerung unuebersehbar.
  // Bewusst fest positioniert mit eigener ID: haengt an keiner App-Struktur,
  // die ein naechster Build verschieben koennte (Lektion aus v29/v39).
  (function () {
    var ID = 'lk-ki-stoerung';
    var TEXTE = {
      guthaben: {
        de: 'KI-Guthaben aufgebraucht. Es kommen keine Antwortvorschläge und keine Übersetzungen, bis Sam auflädt.',
        en: 'AI credit used up. No reply suggestions and no translations until Sam tops up.'
      },
      limit: {
        de: 'KI-Limit erreicht. Antwortvorschläge kommen verzögert.',
        en: 'AI rate limit reached. Reply suggestions are delayed.'
      },
      ueberlast: {
        de: 'Die KI ist gerade überlastet. Antwortvorschläge kommen verzögert.',
        en: 'The AI is overloaded right now. Reply suggestions are delayed.'
      }
    };

    function zeigen(d) {
      var b = document.getElementById(ID);
      if (!b) {
        b = document.createElement('div');
        b.id = ID;
        b.style.cssText = [
          'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
          'z-index:2147483646', 'max-width:min(680px,92vw)', 'box-sizing:border-box',
          'background:#8a1c1c', 'color:#fff',
          'font:600 13px/1.45 system-ui,-apple-system,sans-serif',
          'padding:11px 16px', 'border-radius:10px',
          'box-shadow:0 8px 28px rgba(0,0,0,.28)',
          'text-align:center', 'pointer-events:none'
        ].join(';');
        document.body.appendChild(b);
      }
      var eintrag = TEXTE[d.code] || null;
      var txt = eintrag ? (eintrag[lang === 'en' ? 'en' : 'de']) : (d.grund || '');
      var wann = '';
      try {
        if (d.seit) {
          wann = ' · ' + (lang === 'en' ? 'since ' : 'seit ') +
            new Date(d.seit).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE',
              { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
        }
      } catch (e) {}
      var neu = '⛔ ' + txt + wann;
      if (b.textContent !== neu) b.textContent = neu;
    }

    function verstecken() {
      var b = document.getElementById(ID);
      if (b) b.remove();
    }

    function pruefen() {
      if (document.hidden) return;
      fetch('/api/ki-status', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (!d) return; if (d.ok) verstecken(); else zeigen(d); })
        ['catch'](function () { /* Netz weg: lieber nichts zeigen als Fehlalarm */ });
    }

    setTimeout(pruefen, 3500);
    setInterval(pruefen, 30000);
  })();


  // ── 21) ABSTURZSCHUTZ (v45, 16.09.2026) ───────────────────────────────────
  // Mitarbeiterin A, 16.09.: "Unexpected Application Error! ... insertBefore ... is not
  // a child of this node", danach ging nichts mehr bis zum Neuladen.
  //
  // Das ist KEIN Fehler unserer Daten. React merkt sich die DOM-Knoten, die es
  // selbst erzeugt hat. Ersetzt etwas ausserhalb von React so einen Knoten,
  // findet React ihn beim naechsten Zeichnen nicht mehr und bricht ab. Im
  // Testaufbau nachgestellt: Textknoten von aussen ersetzen genuegt.
  //
  // Der mit Abstand haeufigste Verursacher ist die UEBERSETZUNGSFUNKTION DES
  // BROWSERS. Sie tauscht jeden Textknoten gegen ein <font>-Element. Unser
  // Tool hat einen eigenen DE/EN-Schalter, der das sauber macht - die
  // Browser-Uebersetzung ist daneben schaedlich.
  (function () {
    var WARN = 'lk-uebersetzer-warnung';
    var TOT = 'lk-absturz-hinweis';

    function browserUebersetzungAktiv() {
      try {
        var d = document.documentElement;
        if (d.classList.contains('translated-ltr') || d.classList.contains('translated-rtl')) return true;
        if (document.querySelector('font[_msttexthash],font[_mstmutation],[_msthash]')) return true;
        return false;
      } catch (e) { return false; }
    }

    function leiste(id, farbe, oben) {
      var b = document.getElementById(id);
      if (b) return b;
      b = document.createElement('div');
      b.id = id;
      b.style.cssText = [
        'position:fixed', 'left:50%', (oben ? 'top:12px' : 'bottom:64px'),
        'transform:translateX(-50%)', 'z-index:2147483647',
        'max-width:min(720px,94vw)', 'box-sizing:border-box',
        'background:' + farbe, 'color:#fff',
        'font:600 13px/1.5 system-ui,-apple-system,sans-serif',
        'padding:12px 16px', 'border-radius:10px',
        'box-shadow:0 8px 28px rgba(0,0,0,.3)', 'text-align:center'
      ].join(';');
      document.body.appendChild(b);
      return b;
    }

    function warnungZeigen() {
      var b = leiste(WARN, '#9a5b00', true);
      var txt = (lang === 'en')
        ? 'Your browser is translating this page. That breaks the tool and causes the "Unexpected Application Error". Please switch the browser translation OFF and use the DE/EN button at the top instead.'
        : 'Dein Browser übersetzt diese Seite. Das zerstört die Oberfläche und löst den Fehler "Unexpected Application Error" aus. Bitte die Browser-Übersetzung ausschalten und stattdessen den DE/EN-Schalter oben benutzen.';
      if (b.textContent !== '⚠️ ' + txt) b.textContent = '⚠️ ' + txt;
    }

    function warnungWeg() {
      var b = document.getElementById(WARN);
      if (b) b.remove();
    }

    // Der Totbildschirm von React Router. Bewusst eng gepruefft: eine
    // Ueberschrift mit genau diesem Text. Sonst koennte eine Kundenmail, die
    // den Satz zitiert, einen Fehlalarm ausloesen.
    function totbildschirmDa() {
      try {
        var h = document.querySelectorAll('h1,h2,h3');
        for (var i = 0; i < h.length; i++) {
          if (/^\s*Unexpected Application Error/i.test(String(h[i].textContent || ''))) return true;
        }
      } catch (e) {}
      return false;
    }

    var gemeldet = false;
    function absturzMelden(uebersetzt) {
      if (gemeldet) return;
      gemeldet = true;
      var meldung = '';
      try {
        var h = document.querySelectorAll('h3, pre');
        for (var i = 0; i < h.length; i++) {
          var t = String(h[i].textContent || '');
          if (/Error|insertBefore|removeChild/.test(t)) { meldung = t.slice(0, 200); break; }
        }
      } catch (e) {}
      var bundle = '';
      try {
        var sc = document.querySelectorAll('script[src]');
        for (var j = 0; j < sc.length; j++) {
          if (/index-/.test(sc[j].src)) { bundle = sc[j].src.split('/').pop(); break; }
        }
      } catch (e) {}
      // UMGEBUNG MITSCHICKEN (v46, 16.09.2026): Der Absturz liess sich weder
      // mit Dauerlast noch mit dem Versand-Pfad noch mit einem simulierten
      // Uebersetzer in der echten App ausloesen. Der Ausloeser sitzt also im
      // Browser der Mitarbeiterin. Erweiterungen wie Grammarly oder
      // LanguageTool haengen sich in Textfelder und ersetzen dort Knoten -
      // genau das bringt React zum Absturz. Deshalb melden wir, was im DOM
      // an Fremdspuren zu sehen ist, statt weiter zu raten.
      var spuren = [];
      try {
        if (document.querySelector('[data-gramm],[data-gramm_editor],grammarly-extension,grammarly-desktop-integration')) spuren.push('grammarly');
        if (document.querySelector('.lt-highlighter,[data-lt-installed]')) spuren.push('languagetool');
        if (document.querySelector('font[_msttexthash],font[_mstmutation]')) spuren.push('microsoft-translator');
        if (document.documentElement.className.indexOf('translated-') >= 0) spuren.push('chrome-translate');
        if (document.querySelector('[id^=":"][data-lastpass-icon-root],[data-lastpass-root]')) spuren.push('lastpass');
        if (document.querySelector('[data-dashlane-rid],[data-dashlanecreated]')) spuren.push('dashlane');
        if (document.querySelector('div[id^="bitwarden"]')) spuren.push('bitwarden');
        if (document.querySelector('honey-sidebar,#honeyContainer')) spuren.push('honey');
      } catch (e) {}
      var zahlen = {};
      try {
        zahlen.font = document.querySelectorAll('font').length;
        zahlen.badges = document.querySelectorAll('.lk-conf,.lk-act').length;
        zahlen.enhance = 'v46';
      } catch (e) {}
      try {
        fetch('/api/client-fehler', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            uebersetzt: !!uebersetzt, pfad: location.pathname, bundle: bundle, meldung: meldung,
            spuren: spuren.join(','), zahlen: zahlen, browser: navigator.userAgent
          })
        })['catch'](function () {});
      } catch (e) {}
    }

    function totbildschirmBehandeln() {
      if (document.getElementById(TOT)) return;
      var b = leiste(TOT, '#8a1c1c', true);
      b.textContent = '';
      var p = document.createElement('div');
      var uebersetzt = browserUebersetzungAktiv();
      absturzMelden(uebersetzt);
      p.textContent = (lang === 'en')
        ? (uebersetzt
            ? 'The page crashed because your browser is translating it. Turn the browser translation off, then reload.'
            : 'The page crashed while redrawing. Your drafts are saved. Reload to continue.')
        : (uebersetzt
            ? 'Die Seite ist abgestürzt, weil dein Browser sie übersetzt. Bitte die Browser-Übersetzung ausschalten und dann neu laden.'
            : 'Die Seite ist beim Neuzeichnen abgestürzt. Deine Entwürfe sind gespeichert. Zum Weiterarbeiten neu laden.');
      p.style.cssText = 'margin-bottom:10px';
      // SELBSTHEILUNG (v46): Mitarbeiterin A hat bisher bei jedem Absturz von Hand neu
      // geladen. Das macht die Seite jetzt selbst, mit Countdown und einem
      // Knopf zum Abbrechen - falls sie gerade etwas tippt. Ihre Entwuerfe
      // liegen ohnehin auf dem Server (Auto-Speichern seit v31).
      // Schutz gegen Endlosschleifen: hoechstens 3 Mal pro Sitzung und nie
      // oefter als alle 45 Sekunden.
      var MAX = 3, ABSTAND = 45000;
      var zaehler = 0, letzte = 0;
      try {
        zaehler = parseInt(sessionStorage.getItem('lk_autoreload') || '0', 10) || 0;
        letzte = parseInt(sessionStorage.getItem('lk_autoreload_zeit') || '0', 10) || 0;
      } catch (e) {}
      var darf = zaehler < MAX && (Date.now() - letzte) > ABSTAND;

      var knopf = document.createElement('button');
      knopf.type = 'button';
      knopf.textContent = lang === 'en' ? 'Reload now' : 'Jetzt neu laden';
      knopf.style.cssText = 'cursor:pointer;border:0;border-radius:8px;padding:8px 18px;margin:0 5px;' +
        'font:700 13px system-ui,-apple-system,sans-serif;background:#fff;color:#8a1c1c';
      knopf.onclick = function () { neuLaden(); };

      function neuLaden() {
        try {
          sessionStorage.setItem('lk_autoreload', String(zaehler + 1));
          sessionStorage.setItem('lk_autoreload_zeit', String(Date.now()));
        } catch (e) {}
        location.reload();
      }

      b.appendChild(p);
      b.appendChild(knopf);

      if (darf) {
        var rest = 10;
        var warte = document.createElement('button');
        warte.type = 'button';
        warte.textContent = lang === 'en' ? 'Not yet' : 'Noch nicht';
        warte.style.cssText = 'cursor:pointer;border:1px solid rgba(255,255,255,.55);border-radius:8px;' +
          'padding:8px 14px;margin:0 5px;font:600 13px system-ui,-apple-system,sans-serif;' +
          'background:transparent;color:#fff';
        var zeile = document.createElement('div');
        zeile.style.cssText = 'margin-top:9px;font-weight:600;opacity:.92';
        function tick() {
          zeile.textContent = (lang === 'en' ? 'Reloading automatically in ' : 'Lädt automatisch neu in ')
            + rest + (lang === 'en' ? ' s' : ' Sek.');
        }
        tick();
        var uhr = setInterval(function () {
          rest--;
          if (rest <= 0) { clearInterval(uhr); neuLaden(); return; }
          tick();
        }, 1000);
        warte.onclick = function () { clearInterval(uhr); zeile.remove(); warte.remove(); };
        b.appendChild(warte);
        b.appendChild(zeile);
      }
    }

    function pruefen() {
      try {
        if (browserUebersetzungAktiv()) warnungZeigen(); else warnungWeg();
        if (totbildschirmDa()) totbildschirmBehandeln();
      } catch (e) {}
    }

    setTimeout(pruefen, 2500);
    setInterval(pruefen, 3000);
  })();


  // ── 22) BCC IM FENSTER "NEW EMAIL" (v47, 19.09.2026) ──────────────────────
  // Samuel will Trustpilot per BCC einladen, genau wie Trustpilot es
  // beschreibt: Adresse ins BCC-Feld der Kundenmail, normal senden. Das Tool
  // hatte kein BCC-Feld. Jetzt: Feld unter "Betreff" (nur Admins). Der Wert
  // geht mit dem Anlegen an /api/compose, der Server merkt ihn sich am Ticket
  // und schickt ihn beim Senden genau einmal mit.
  (function () {
    var FELD = 'lk-bcc-feld';
    var LABEL_KL = 'mb-1 block text-[11px] font-semibold uppercase text-muted-foreground/70';
    var INPUT_KL = 'h-9 w-full rounded-lg border border-border bg-muted/30 px-3 text-[14px] outline-none focus:border-ring focus:bg-white focus:ring-2 focus:ring-ring/20';

    function fenster() {
      var h = document.querySelectorAll('h3');
      for (var i = 0; i < h.length; i++) {
        var t = String(h[i].textContent || '').trim();
        if (t === 'Neue E-Mail' || t === 'New email' || t === 'New Email') {
          var box = h[i].parentElement && h[i].parentElement.parentElement;
          if (box) return box;
        }
      }
      return null;
    }

    function bccGueltig(w) { return /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(w); }

    function einbauen() {
      if (!lkIstAdmin) return;
      var box = fenster();
      if (!box || box.querySelector('#' + FELD)) return;
      var liste = box.querySelector('.space-y-3');
      if (!liste || liste.children.length < 2) return;
      var betreff = liste.children[1];          // An, Betreff, Nachricht
      var block = document.createElement('div');
      block.id = FELD;
      var l = document.createElement('label');
      l.className = LABEL_KL;
      l.textContent = 'BCC';
      l.setAttribute('translate', 'no');
      var inp = document.createElement('input');
      inp.id = FELD + '-input';
      inp.type = 'email';
      inp.autocomplete = 'off';
      inp.className = INPUT_KL;
      inp.placeholder = lang === 'en' ? 'optional, e.g. your Trustpilot address' : 'optional, z. B. deine Trustpilot-Adresse';
      // v49 (21.09.2026): Samuel hatte einen ganzen Satz ins BCC-Feld
      // geschrieben. Der Server lehnte ab, das Fenster zeigte aber keinen
      // Grund und "Save as draft" tat scheinbar nichts. Jetzt: sofort rot mit
      // Hinweis, und beim Speichern eine klare Meldung.
      var hinweis = document.createElement('div');
      hinweis.id = FELD + '-hinweis';
      hinweis.style.cssText = 'display:none;margin-top:4px;font-size:12px;color:#b42318';
      inp.addEventListener('input', function () {
        var w = String(inp.value || '').trim();
        var ok = !w || bccGueltig(w);
        inp.style.borderColor = ok ? '' : '#b42318';
        hinweis.style.display = ok ? 'none' : 'block';
        hinweis.textContent = lang === 'en'
          ? 'BCC must be one email address (e.g. your Trustpilot address). Text belongs in the message below.'
          : 'BCC muss eine einzelne E-Mail-Adresse sein (z. B. deine Trustpilot-Adresse). Text gehört unten in die Nachricht.';
      });
      block.appendChild(l);
      block.appendChild(inp);
      block.appendChild(hinweis);
      betreff.insertAdjacentElement('afterend', block);
    }

    // Den BCC-Wert an das Anlegen der Mail haengen.
    var altFetch = window.fetch;
    window.fetch = function (url, opts) {
      try {
        var u = typeof url === 'string' ? url : (url && url.url) || '';
        if (/\/api\/compose(\?|$)/.test(u) && opts && String(opts.method || '').toUpperCase() === 'POST' && typeof opts.body === 'string') {
          var inp = document.getElementById(FELD + '-input');
          var wert = inp ? String(inp.value || '').trim() : '';
          if (wert && !bccGueltig(wert)) {
            toast(lang === 'en'
              ? 'Not saved: the BCC field must contain one email address, not text.'
              : 'Nicht gespeichert: Im BCC-Feld muss eine E-Mail-Adresse stehen, kein Text.', false);
            try { inp.focus(); inp.dispatchEvent(new Event('input')); } catch (e2) {}
            return Promise.reject(new Error('BCC ungueltig'));
          }
          if (wert) {
            var b = JSON.parse(opts.body);
            b.bcc = wert;
            opts = Object.assign({}, opts, { body: JSON.stringify(b) });
          }
        }
      } catch (e) {}
      return altFetch.call(this, url, opts);
    };

    setInterval(function () { try { einbauen(); } catch (e) {} }, 400);
  })();


  // ── 23) LINKS IM ENTWURF BEARBEITEN (v48, 20.09.2026) ─────────────────────
  // Mitarbeiterin Bs Wunsch (15.09.): "I've been trying to find where to hyperlink".
  // Der Entwurf zeigt [Text](URL) als echten Link, rendert ihn aber mit
  // contenteditable="false". Man konnte Links also weder aendern noch neue
  // anlegen. Jetzt: Klick auf einen Link oeffnet ein kleines Fenster (Text,
  // Adresse, testen, entfernen). Markierter Text + Knopf "Link" oder
  // Strg/Cmd+K legt einen neuen Link an.
  // Technik: React verwaltet das Innere von .rich-draft nicht (innerHTML wird
  // von Hand gesetzt, onInput liest das DOM zurueck). Wir aendern deshalb das
  // DOM und loesen ein input-Ereignis aus - die App uebernimmt den neuen Stand
  // samt Auto-Speichern ganz von selbst.
  (function () {
    var POP = 'lk-link-pop', KNOPF = 'lk-link-knopf';
    // Texte erst beim Oeffnen bestimmen: Die Sprache kommt vom Server und
    // steht beim Laden der Seite noch nicht fest (sonst Deutsch/Englisch gemischt).
    var T = {};
    function texte() {
      var en = lang === 'en';
      T = {
        text: en ? 'Link text' : 'Linktext',
        url: en ? 'Web address' : 'Adresse',
        textPh: en ? 'e.g. Track shipment' : 'z. B. Sendung verfolgen',
        ok: en ? 'Save' : 'Speichern',
        neu: en ? 'Add link' : 'Link einfügen',
        weg: en ? 'Remove link' : 'Link entfernen',
        test: en ? 'Test link' : 'Link testen',
        knopf: en ? 'Link' : 'Link',
        fehlerUrl: en ? 'Please enter a valid web address, e.g. https://www.dhl.de/...' : 'Bitte eine gültige Adresse eingeben, z. B. https://www.dhl.de/...',
        fehlerText: en ? 'Please enter the words the customer should see.' : 'Bitte den Text eingeben, den die Kundin sehen soll.'
      };
    }
    texte();

    function urlSauber(u) {
      u = String(u || '').trim();
      if (!u) return '';
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      return u.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
    }
    function urlGueltig(u) { return /^https?:\/\/[^\s)]+\.[^\s)]{2,}$/i.test(u); }
    function textSauber(t) { return String(t || '').replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }
    function melden(d) { try { d.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {} }
    function zu() { var p = document.getElementById(POP); if (p) p.remove(); }

    // opts: { entwurf, link (vorhandenes <a>) ODER bereich (Range), rect }
    function auf(opts) {
      zu();
      texte();
      var p = document.createElement('div');
      p.id = POP;
      p.setAttribute('translate', 'no');
      var oben = Math.min(window.innerHeight - 250, Math.max(12, opts.rect.bottom + 8));
      var links = Math.min(window.innerWidth - 372, Math.max(12, opts.rect.left));
      p.style.cssText = 'position:fixed;z-index:2147483600;top:' + oben + 'px;left:' + links + 'px;width:360px;' +
        'box-sizing:border-box;background:#fff;border:1px solid #d5e3d8;border-radius:12px;padding:14px;' +
        'box-shadow:0 12px 36px rgba(0,0,0,.2);font:13px/1.4 system-ui,-apple-system,sans-serif;color:#0f2a20';
      function feld(label, wert, ph) {
        var l = document.createElement('label');
        l.textContent = label;
        l.style.cssText = 'display:block;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#5b7a6c;margin:0 0 4px';
        var i = document.createElement('input');
        i.type = 'text'; i.value = wert || ''; i.placeholder = ph || '';
        i.style.cssText = 'display:block;width:100%;box-sizing:border-box;height:34px;border:1px solid #cfdcd3;border-radius:8px;padding:0 10px;font:inherit;margin:0 0 10px;outline:none';
        i.onfocus = function () { i.style.borderColor = '#2E7D32'; };
        i.onblur = function () { i.style.borderColor = '#cfdcd3'; };
        p.appendChild(l); p.appendChild(i);
        return i;
      }
      var iText = feld(T.text, opts.link ? opts.link.textContent : (opts.bereich ? String(opts.bereich.toString()) : ''), T.textPh);
      var iUrl = feld(T.url, opts.link ? opts.link.getAttribute('href') : '', 'https://');
      var hinweis = document.createElement('div');
      hinweis.style.cssText = 'display:none;color:#b42318;font-size:12px;margin:-4px 0 10px';
      p.appendChild(hinweis);
      var zeile = document.createElement('div');
      zeile.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      function knopf(text, stil, fn) {
        var b = document.createElement('button');
        b.type = 'button'; b.textContent = text;
        b.style.cssText = 'cursor:pointer;border-radius:8px;padding:7px 12px;font:600 12.5px system-ui,-apple-system,sans-serif;' + stil;
        b.onclick = fn; zeile.appendChild(b); return b;
      }
      function speichern() {
        var t = textSauber(iText.value), u = urlSauber(iUrl.value);
        if (!t) { hinweis.textContent = T.fehlerText; hinweis.style.display = 'block'; iText.focus(); return; }
        if (!urlGueltig(u)) { hinweis.textContent = T.fehlerUrl; hinweis.style.display = 'block'; iUrl.focus(); return; }
        if (opts.link) {
          opts.link.textContent = t;
          opts.link.setAttribute('href', u);
        } else {
          var a = document.createElement('a');
          a.setAttribute('href', u);
          a.setAttribute('contenteditable', 'false');
          a.textContent = t;
          var r = opts.bereich;
          r.deleteContents();
          r.insertNode(a);
          if (!a.nextSibling) a.parentNode.appendChild(document.createTextNode(' '));
          try {
            var s = window.getSelection(), n = document.createRange();
            n.setStartAfter(a); n.collapse(true); s.removeAllRanges(); s.addRange(n);
          } catch (e) {}
        }
        melden(opts.entwurf);
        zu();
      }
      knopf(opts.link ? T.ok : T.neu, 'border:0;background:#1E4D2B;color:#fff', speichern);
      if (opts.link) {
        knopf(T.weg, 'border:1px solid #e3c4c0;background:#fff;color:#b42318', function () {
          opts.link.replaceWith(document.createTextNode(opts.link.textContent));
          melden(opts.entwurf); zu();
        });
      }
      knopf(T.test + ' ↗', 'border:1px solid #cfdcd3;background:#fff;color:#1E4D2B;margin-left:auto', function () {
        var u = urlSauber(iUrl.value);
        if (!urlGueltig(u)) { hinweis.textContent = T.fehlerUrl; hinweis.style.display = 'block'; return; }
        window.open(u, '_blank', 'noopener');
      });
      p.appendChild(zeile);
      p.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); speichern(); }
        if (e.key === 'Escape') { e.preventDefault(); zu(); }
        e.stopPropagation();
      });
      document.body.appendChild(p);
      (opts.link || iText.value ? iUrl : iText).focus();
      if (opts.link) iUrl.select();
    }

    // 1) Klick auf einen vorhandenen Link im Entwurf
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.rich-draft a') : null;
      if (a) {
        e.preventDefault(); e.stopPropagation();
        auf({ entwurf: a.closest('.rich-draft'), link: a, rect: a.getBoundingClientRect() });
        return;
      }
      var p = document.getElementById(POP);
      if (p && !p.contains(e.target) && !(e.target.closest && e.target.closest('#' + KNOPF))) zu();
    }, true);

    // 2) Markierung im Entwurf -> schwebender Knopf "Link"
    function auswahl() {
      var s = window.getSelection();
      if (!s || !s.rangeCount) return null;
      var r = s.getRangeAt(0);
      var k = r.commonAncestorContainer;
      var el = k.nodeType === 1 ? k : k.parentElement;
      var d = el && el.closest ? el.closest('.rich-draft') : null;
      if (!d) return null;
      if (el.closest('a')) return null;                 // nicht innerhalb eines Links
      return { entwurf: d, bereich: r };
    }
    function knopfZeigen() {
      var alt = document.getElementById(KNOPF);
      var a = auswahl();
      if (!a || a.bereich.collapsed || !String(a.bereich.toString()).trim() || document.getElementById(POP)) { if (alt) alt.remove(); return; }
      var rect = a.bereich.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { if (alt) alt.remove(); return; }
      texte();
      var b = alt || document.createElement('button');
      if (!alt) {
        b.id = KNOPF; b.type = 'button';
        b.setAttribute('translate', 'no');
        b.textContent = '🔗 ' + T.knopf;
        b.addEventListener('mousedown', function (e) { e.preventDefault(); });   // Markierung behalten
        b.addEventListener('click', function () {
          var jetzt = auswahl();
          if (!jetzt) return;
          var rr = jetzt.bereich.getBoundingClientRect();
          b.remove();
          auf({ entwurf: jetzt.entwurf, bereich: jetzt.bereich.cloneRange(), rect: rr });
        });
        document.body.appendChild(b);
      }
      b.style.cssText = 'position:fixed;z-index:2147483599;cursor:pointer;border:0;border-radius:999px;' +
        'padding:6px 12px;background:#1E4D2B;color:#fff;font:700 12px system-ui,-apple-system,sans-serif;' +
        'box-shadow:0 6px 18px rgba(0,0,0,.25);top:' + Math.max(8, rect.top - 38) + 'px;left:' +
        Math.min(window.innerWidth - 90, Math.max(8, rect.left + rect.width / 2 - 36)) + 'px';
    }
    document.addEventListener('selectionchange', function () { try { knopfZeigen(); } catch (e) {} });
    window.addEventListener('scroll', function () { var k = document.getElementById(KNOPF); if (k) k.remove(); }, true);

    // 3) Strg/Cmd+K im Entwurf
    document.addEventListener('keydown', function (e) {
      if (!(e.metaKey || e.ctrlKey) || String(e.key).toLowerCase() !== 'k') return;
      var a = auswahl();
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      var rect = a.bereich.getBoundingClientRect();
      if (!rect.width && !rect.height) rect = a.entwurf.getBoundingClientRect();
      var k = document.getElementById(KNOPF); if (k) k.remove();
      auf({ entwurf: a.entwurf, bereich: a.bereich.cloneRange(), rect: rect });
    }, true);
  })();

  // ── 24) NEUIGKEITEN-POP-UP (v48, 20.09.2026) ──────────────────────────────
  // Samuel: Wenn wir etwas einbauen, das sich eine Mitarbeiterin gewuenscht
  // hat, soll sie es beim naechsten Oeffnen des Tools sehen. Die Eintraege
  // liegen auf dem Server (data/neuigkeiten.json, pro Person oder fuer alle).
  // "Gesehen" wird erst beim Klick auf den Knopf gespeichert, und zwar auf dem
  // Server - das Pop-up kommt also auf jedem Geraet genau einmal.
  (function () {
    var ID = 'lk-neuigkeit';
    function zeigen(liste) {
      if (!liste.length || document.getElementById(ID)) return;
      var n = liste[0], en = lang === 'en';
      var hg = document.createElement('div');
      hg.id = ID;
      hg.setAttribute('translate', 'no');
      hg.style.cssText = 'position:fixed;inset:0;z-index:2147483640;background:rgba(10,30,20,.45);display:flex;align-items:center;justify-content:center;padding:16px';
      var k = document.createElement('div');
      k.style.cssText = 'width:100%;max-width:460px;box-sizing:border-box;background:#fff;border-radius:18px;padding:26px 26px 22px;' +
        'box-shadow:0 24px 70px rgba(0,0,0,.3);font:14px/1.55 system-ui,-apple-system,sans-serif;color:#0f2a20';
      var marke = document.createElement('div');
      marke.textContent = en ? 'NEW IN THE TOOL' : 'NEU IM TOOL';
      marke.style.cssText = 'display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.09em;color:#1E4D2B;background:#E8F3E9;border-radius:999px;padding:4px 10px;margin-bottom:12px';
      var h = document.createElement('div');
      h.textContent = (en ? n.titel_en : n.titel_de) || n.titel_de || n.titel_en || '';
      h.style.cssText = 'font-size:20px;font-weight:800;line-height:1.25;margin-bottom:10px';
      k.appendChild(marke); k.appendChild(h);
      var zeilen = (en ? n.text_en : n.text_de) || n.text_de || n.text_en || [];
      if (typeof zeilen === 'string') zeilen = [zeilen];
      zeilen.forEach(function (z) {
        var d = document.createElement('div');
        var punkt = /^•\s?/.test(z);
        d.textContent = z;
        d.style.cssText = 'margin:0 0 8px;' + (punkt ? 'padding-left:4px;color:#23402f' : '');
        k.appendChild(d);
      });
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = en ? 'Got it' : 'Alles klar';
      b.style.cssText = 'margin-top:12px;cursor:pointer;border:0;border-radius:10px;width:100%;padding:11px 16px;background:#1E4D2B;color:#fff;font:700 14px system-ui,-apple-system,sans-serif';
      b.onclick = function () {
        b.disabled = true;
        fetch('/api/neuigkeiten/' + encodeURIComponent(n.id) + '/gesehen', { method: 'POST', credentials: 'same-origin' })
          ['catch'](function () {})
          .then(function () { hg.remove(); zeigen(liste.slice(1)); });
      };
      k.appendChild(b);
      hg.appendChild(k);
      document.body.appendChild(hg);
    }
    setTimeout(function () {
      fetch('/api/neuigkeiten', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { if (d && Array.isArray(d.neuigkeiten)) zeigen(d.neuigkeiten); })
        ['catch'](function () {});
    }, 3000);
  })();


  // ── 25) WER HAT GESENDET (v50, 22.09.2026) ────────────────────────────────
  // Mitarbeiterin A: "How will I know if Mitarbeiterin B responded or I responded?" Der Server
  // liefert jetzt pro gesendeter Nachricht gesendetVon (Admins als "Team").
  // Ausgehende Sprechblasen erkennt man an flex-row-reverse; sie stehen in
  // derselben Reihenfolge wie die ausgehenden Nachrichten des Tickets.
  (function () {
    var KL = 'lk-absender';
    var cache = { id: null, at: 0, liste: null, laeuft: null };
    function ticketLaden(id) {
      var now = Date.now();
      if (cache.id === id && now - cache.at < 4000) return Promise.resolve(cache.liste);
      if (cache.laeuft) return cache.laeuft;
      cache.laeuft = fetch('/api/inbound', { credentials: 'include' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var t = ((d && d.tickets) || []).find(function (x) { return String(x.id) === String(id); });
          var liste = t ? (t.messages || []).filter(function (m) { return m.direction === 'out' && !m.is_internal_note; }) : null;
          cache = { id: id, at: Date.now(), liste: liste, laeuft: null };
          return liste;
        })['catch'](function () { cache.laeuft = null; return null; });
      return cache.laeuft;
    }
    function farbe(name) {
      var n = String(name || '').toLowerCase();
      if (n === 'krissa') return { bg: '#E8F0FE', fg: '#1a4fb4', bd: '#c3d4f5' };
      if (n === 'maggie') return { bg: '#F3E8FD', fg: '#6b2fb3', bd: '#dcc6f2' };
      if (n === 'team') return { bg: '#EEF2EF', fg: '#3e6857', bd: '#d5e3d8' };
      return { bg: '#FFF4E0', fg: '#8a5a00', bd: '#f0dcae' };
    }
    function anbringen() {
      var id = currentTicketId();
      if (!id) return;
      var blasen = [].slice.call(document.querySelectorAll('div.flex-row-reverse.mb-4'));
      if (!blasen.length) return;
      ticketLaden(id).then(function (liste) {
        if (!liste) return;
        var blasen2 = [].slice.call(document.querySelectorAll('div.flex-row-reverse.mb-4'));
        if (blasen2.length !== liste.length) return;   // Ansicht passt nicht zur Liste: lieber nichts als falsch
        for (var i = 0; i < blasen2.length; i++) {
          var m = liste[i];
          var wer = m.gesendetVon || m.sentByName || null;
          if (!wer) continue;
          var karte = blasen2[i].querySelector('div.rounded-xl');
          if (!karte) continue;
          var tag = karte.querySelector('.' + KL);
          var text = String(wer).toUpperCase();
          if (tag && tag.textContent === text) continue;
          if (!tag) {
            tag = document.createElement('div');
            tag.className = KL;
            tag.setAttribute('translate', 'no');
            karte.appendChild(tag);
          }
          var f = farbe(wer);
          tag.textContent = text;
          tag.title = (lang === 'en' ? 'Sent by ' : 'Gesendet von ') + wer;
          tag.style.cssText = 'display:inline-block;float:right;margin:8px 0 0 10px;padding:2px 8px;border-radius:999px;' +
            'font:800 10px/1.6 system-ui,-apple-system,sans-serif;letter-spacing:.06em;' +
            'background:' + f.bg + ';color:' + f.fg + ';border:1px solid ' + f.bd + ';user-select:none';
        }
      });
    }
    setInterval(function () { try { anbringen(); } catch (e) {} }, 1200);
  })();


  // ── 26) VORGESCHICHTE IN KURZ (v51, 23.09.2026) ───────────────────────────
  // Mitarbeiterin Bs Vorschlag: KI-Zusammenfassung der bisherigen Kontakte, direkt
  // UEBER dem Entwurf. Server: GET /api/inbound/:id/zusammenfassung (Haiku,
  // zwischengespeichert). Das Feld sitzt als Geschwister VOR .rich-draft,
  // nicht darin - so landet die Zusammenfassung nie im Mailtext.
  (function () {
    var ID = 'lk-vorgeschichte';
    var daten = {};          // ticketId -> { status: 'laedt'|'ok'|'leer'|'fehler', d }
    function zu() { try { return localStorage.getItem('lk_vg_zu') === '1'; } catch (e) { return false; } }
    function setZu(v) { try { localStorage.setItem('lk_vg_zu', v ? '1' : '0'); } catch (e) {} }

    function laden(id, neu) {
      daten[id] = { status: 'laedt' };
      fetch('/api/inbound/' + encodeURIComponent(id) + '/zusammenfassung' + (neu ? '?neu=1' : ''), { credentials: 'include' })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (x) {
          if (!x.ok) { daten[id] = { status: 'fehler', d: x.j }; }
          else if (!x.j.noetig) { daten[id] = { status: 'leer' }; }
          else { daten[id] = { status: 'ok', d: x.j }; }
          var p = document.getElementById(ID); if (p) p.remove();
        })['catch'](function () { daten[id] = { status: 'fehler', d: {} }; var p = document.getElementById(ID); if (p) p.remove(); });
    }

    function textRendern(ziel, text) {
      var en = lang === 'en';
      String(text || '').split('\n').forEach(function (z) {
        z = z.trim(); if (!z) return;
        var d = document.createElement('div');
        var punkt = /^[-•]\s*/.test(z);
        var m = z.match(/^(Situation|History|Open \/ promised|Watch out|Lage|Verlauf|Offen \/ zugesagt|Achtung):\s*(.*)$/i);
        if (punkt) {
          d.textContent = '• ' + z.replace(/^[-•]\s*/, '');
          d.style.cssText = 'padding-left:10px;margin:1px 0;color:#23402f';
        } else if (m) {
          var b = document.createElement('span');
          b.textContent = m[1] + ': ';
          var warn = /watch out|achtung/i.test(m[1]);
          b.style.cssText = 'font-weight:800;color:' + (warn ? '#b42318' : '#1E4D2B');
          d.appendChild(b);
          if (m[2]) d.appendChild(document.createTextNode(m[2]));
          d.style.cssText = 'margin:6px 0 1px;' + (warn ? 'color:#8a1c1c' : '');
        } else {
          d.textContent = z; d.style.cssText = 'margin:1px 0';
        }
        ziel.appendChild(d);
      });
    }

    function bauen(id, eintrag) {
      var en = lang === 'en';
      var p = document.createElement('div');
      p.id = ID; p.setAttribute('data-ticket', id); p.setAttribute('translate', 'no');
      p.setAttribute('contenteditable', 'false');
      p.style.cssText = 'margin:0 0 14px;border:1px solid #d5e3d8;border-radius:12px;background:#F6FAF7;' +
        'font:13px/1.5 system-ui,-apple-system,sans-serif;color:#0f2a20;overflow:hidden';
      var kopf = document.createElement('div');
      kopf.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;user-select:none';
      var titel = document.createElement('div');
      titel.style.cssText = 'font-weight:800;flex:1';
      var info = '';
      if (eintrag.status === 'ok') {
        var d = eintrag.d;
        info = en
          ? ' · ' + d.tickets + (d.tickets === 1 ? ' ticket' : ' tickets') + ', ' + d.nachrichten + ' messages since ' + d.erster
          : ' · ' + d.tickets + (d.tickets === 1 ? ' Ticket' : ' Tickets') + ', ' + d.nachrichten + ' Nachrichten seit ' + d.erster;
      }
      titel.textContent = '📋 ' + (en ? 'Customer history (AI summary)' : 'Vorgeschichte (KI-Zusammenfassung)') + info;
      var pfeil = document.createElement('span');
      pfeil.style.cssText = 'color:#5b7a6c;font-size:12px';
      kopf.appendChild(titel);
      var neu = document.createElement('button');
      neu.type = 'button';
      neu.textContent = '↻';
      neu.title = en ? 'Summarize again' : 'Neu zusammenfassen';
      neu.style.cssText = 'cursor:pointer;border:1px solid #cfdcd3;background:#fff;border-radius:7px;padding:1px 8px;font:700 13px system-ui;color:#1E4D2B';
      neu.onclick = function (e) { e.stopPropagation(); laden(id, true); var x = document.getElementById(ID); if (x) x.remove(); };
      if (eintrag.status === 'ok') kopf.appendChild(neu);
      kopf.appendChild(pfeil);
      var rumpf = document.createElement('div');
      rumpf.style.cssText = 'padding:0 14px 11px';
      if (eintrag.status === 'laedt') {
        rumpf.textContent = en ? 'Reading all previous conversations with this customer…' : 'Lese alle bisherigen Gespräche mit dieser Kundin…';
        rumpf.style.color = '#5b7a6c';
      } else if (eintrag.status === 'fehler') {
        rumpf.textContent = (en ? 'Summary not available right now. ' : 'Zusammenfassung gerade nicht verfügbar. ') + ((eintrag.d && eintrag.d.error) || '');
        rumpf.style.color = '#8a5a00';
      } else {
        textRendern(rumpf, eintrag.d.text);
        var fuss = document.createElement('div');
        fuss.textContent = en ? 'AI summary. Please check important details in the conversation before promising anything.' : 'KI-Zusammenfassung. Wichtige Details vor Zusagen bitte im Verlauf prüfen.';
        fuss.style.cssText = 'margin-top:8px;font-size:11px;color:#6b7f74';
        rumpf.appendChild(fuss);
      }
      function stand() {
        var z = zu() && eintrag.status === 'ok';
        rumpf.style.display = z ? 'none' : 'block';
        pfeil.textContent = z ? (en ? 'show ▾' : 'anzeigen ▾') : (en ? 'hide ▴' : 'einklappen ▴');
      }
      kopf.onclick = function () { setZu(!zu()); stand(); };
      stand();
      p.appendChild(kopf); p.appendChild(rumpf);
      return p;
    }

    function takt() {
      var id = currentTicketId();
      var draft = document.querySelector('.rich-draft');
      var alt = document.getElementById(ID);
      if (!id || !draft) { if (alt) alt.remove(); return; }
      if (!daten[id]) laden(id, false);
      var e = daten[id];
      if (e.status === 'leer') { if (alt) alt.remove(); return; }
      if (alt && alt.getAttribute('data-ticket') === id && alt.getAttribute('data-status') === e.status && alt.nextElementSibling === draft) return;
      if (alt) alt.remove();
      var p = bauen(id, e);
      p.setAttribute('data-status', e.status);
      draft.parentNode.insertBefore(p, draft);
    }
    setInterval(function () { try { takt(); } catch (e) {} }, 700);
  })();

})();