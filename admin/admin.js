/* Century Marina Hotel · menu manager
   The menu lives in data/menu.json inside the GitHub repository that hosts
   the site. This page signs in, then reads and writes that file (and the
   product photos in images/) through the GitHub API.

   Sign-in: the username and password unlock a GitHub access key that is
   stored encrypted in admin/auth.json (PBKDF2 + AES-GCM). Without the right
   password the file is useless, and without the key nothing can be changed. */
(function () {
  'use strict';

  var API = 'https://api.github.com';
  var ITERATIONS = 600000;
  var AUTH_PATH = 'admin/auth.json';
  var MENU_PATH = 'data/menu.json';
  var SESSION_KEY = 'cm_admin_session';

  var app = document.getElementById('app');
  var enc = new TextEncoder();
  var dec = new TextDecoder();
  var state = { repo: null, gh: null, user: '', menu: null, sha: null };
  var freshPhotos = {};   // photos uploaded in this visit, shown before the site republishes
  var lastGroup = {};     // remembers the last group picked per section

  /* ---------- small helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function en(o) { return (o && (o.en || o.ar)) || ''; }
  function toB64(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var s = '';
    for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(s) {
    var bin = atob(String(s).replace(/\s/g, ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function uid(prefix) {
    var a = crypto.getRandomValues(new Uint8Array(5));
    return prefix + Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function slug(s) {
    return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }
  function money(n) { if (n === '' || n == null) return ''; var v = Number(n); return isFinite(v) ? (v % 1 === 0 ? String(v) : v.toFixed(2)) : ''; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function UserError(message) { var e = new Error(message); e.userMessage = message; return e; }

  function explain(e) {
    if (e && e.userMessage) return e.userMessage;
    if (e && e.status === 401) return 'Your access to the menu has expired. Log out and log in again.';
    if (e && e.status === 403) {
      return /rate limit/i.test(e.detail || '')
        ? 'Too many changes in a short time. Wait a minute and try again.'
        : 'GitHub refused the change. The access key does not have permission to edit this menu.';
    }
    if (e && e.status === 404) return 'The menu file was not found in the repository.';
    if (e instanceof TypeError) return 'No connection. Check the internet and try again.';
    return 'Something went wrong' + (e && e.status ? ' (error ' + e.status + ')' : '') + '. Try again.';
  }

  function toast(message, kind) {
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' toast--' + kind : '');
    el.textContent = message;
    $('toasts').appendChild(el);
    setTimeout(function () { el.classList.add('toast--out'); }, kind === 'error' ? 6500 : 3800);
    setTimeout(function () { el.remove(); }, kind === 'error' ? 7000 : 4300);
  }

  function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(v) {
    try { if (v) sessionStorage.setItem(SESSION_KEY, JSON.stringify(v)); else sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
  }

  /* ---------- where is the repository ---------- */
  function detectRepo() {
    var c = window.MENU_CONFIG || {};
    if (c.owner && c.repo) return { owner: c.owner, repo: c.repo, branch: c.branch || '' };
    var host = location.hostname;
    if (/\.github\.io$/i.test(host)) {
      var owner = host.split('.')[0];
      var first = location.pathname.split('/').filter(Boolean)[0];
      var repo = (!first || first === 'admin') ? owner + '.github.io' : first;
      return { owner: owner, repo: repo, branch: c.branch || '' };
    }
    return null;
  }
  function siteUrl() { var u = new URL('../', location.href); u.search = ''; u.hash = ''; return u.href; }

  /* ---------- GitHub ---------- */
  function GitHub(owner, repo, token, branch) {
    this.base = API + '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    this.token = token;
    this.branch = branch;
  }
  GitHub.prototype.call = async function (method, path, body) {
    var headers = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + this.token, 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) headers['Content-Type'] = 'application/json';
    var res = await fetch(this.base + path, { method: method, headers: headers, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      var err = new Error('GitHub ' + res.status);
      err.status = res.status;
      try { err.detail = (await res.json()).message || ''; } catch (e) { err.detail = ''; }
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };
  function filePath(p) { return '/contents/' + p.split('/').map(encodeURIComponent).join('/'); }
  GitHub.prototype.read = async function (path) {
    var j = await this.call('GET', filePath(path) + '?ref=' + encodeURIComponent(this.branch));
    var content = j.content || '';
    /* GitHub leaves the content out for files over 1 MB: fetch it by its id instead */
    if (!content && j.size > 0) content = (await this.call('GET', '/git/blobs/' + j.sha)).content || '';
    return { sha: j.sha, bytes: fromB64(content) };
  };
  GitHub.prototype.write = function (path, bytes, message, sha) {
    var body = { message: message, content: toB64(bytes), branch: this.branch };
    if (sha) body.sha = sha;
    return this.call('PUT', filePath(path), body);
  };
  GitHub.prototype.remove = async function (path, message) {
    var j = await this.call('GET', filePath(path) + '?ref=' + encodeURIComponent(this.branch));
    return this.call('DELETE', filePath(path), { message: message, sha: j.sha, branch: this.branch });
  };

  /* ---------- sign-in crypto ---------- */
  async function deriveKey(user, pass, salt, iterations) {
    var material = await crypto.subtle.importKey('raw', enc.encode(user.trim().toLowerCase() + '\n' + pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(user, pass, token) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var key = await deriveKey(user, pass, salt, ITERATIONS);
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, enc.encode(token));
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toB64(salt), iv: toB64(iv), key: toB64(ct) };
  }
  async function unseal(auth, user, pass) {
    var key = await deriveKey(user, pass, fromB64(auth.salt), auth.iterations || ITERATIONS);
    var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(auth.iv) }, key, fromB64(auth.key));
    return dec.decode(pt);
  }
  async function loadAuth() {
    var res = await fetch('auth.json?t=' + Date.now(), { cache: 'no-store' });
    if (res.ok) { try { var j = await res.json(); if (j && j.key) return j; } catch (e) { /* not json */ } }
    /* just after the first setup the site has not republished yet: ask GitHub directly */
    try {
      var r = await fetch(API + '/repos/' + state.repo.owner + '/' + state.repo.repo + '/contents/' + AUTH_PATH + '?t=' + Date.now(), { cache: 'no-store', headers: { 'Accept': 'application/vnd.github+json' } });
      if (r.ok) { var f = await r.json(); return JSON.parse(dec.decode(fromB64(f.content))); }
    } catch (e) { /* fall through */ }
    return null;
  }

  /* ---------- menu data ---------- */
  async function connect(token, user) {
    var gh = new GitHub(state.repo.owner, state.repo.repo, token, state.repo.branch);
    var info = await gh.call('GET', '');
    if (!gh.branch) gh.branch = info.default_branch;
    state.gh = gh;
    state.user = user;
    await loadMenu();
  }
  async function loadMenu() {
    var f = await state.gh.read(MENU_PATH);
    state.sha = f.sha;
    state.menu = JSON.parse(dec.decode(f.bytes));
  }
  var queue = Promise.resolve();
  function wait(ms) { return new Promise(function (ok) { setTimeout(ok, ms); }); }
  /* every write to GitHub goes through this queue, one at a time, so two quick
     edits (or a save and a photo clean-up) never collide on the branch */
  function enqueue(job) {
    var p = queue.then(job, job);
    queue = p.catch(function () {});
    return p;
  }
  /* a write that does not touch the menu file (photos, the login file) */
  function writeFile(path, bytes, message) {
    return enqueue(async function () {
      for (var attempt = 0; ; attempt++) {
        try {
          var sha = null;
          try { sha = (await state.gh.read(path)).sha; } catch (e) { if (e.status !== 404) throw e; }
          return await state.gh.write(path, bytes, message, sha);
        } catch (e) {
          if (e.status === 409 && attempt < 3) { await wait(700 * (attempt + 1)); continue; }
          throw e;
        }
      }
    });
  }
  function removeFile(path, message) {
    return enqueue(async function () {
      for (var attempt = 0; ; attempt++) {
        try { return await state.gh.remove(path, message); }
        catch (e) {
          if (e.status === 409 && attempt < 3) { await wait(700 * (attempt + 1)); continue; }
          if (e.status === 404) return null;
          throw e;
        }
      }
    }).catch(function () { /* a leftover photo is harmless */ });
  }
  function commit(message, change) {
    var run = async function () {
      var draft = JSON.parse(JSON.stringify(state.menu));
      change(draft);
      draft.restaurants.forEach(function (r) {
        r.sections.forEach(function (s) {
          s.groups = (s.groups || []).filter(function (g) { return s.items.some(function (it) { return it.group === g.id; }); });
        });
      });
      draft.updated = new Date().toISOString();
      var bytes = enc.encode(JSON.stringify(draft, null, 1) + '\n');
      for (var attempt = 0; ; attempt++) {
        try {
          var res = await state.gh.write(MENU_PATH, bytes, message, state.sha);
          state.sha = res.content.sha;
          state.menu = draft;
          return;
        } catch (e) {
          if (e.status !== 409 && e.status !== 422) throw e;
          var now = await state.gh.read(MENU_PATH);
          /* same file as before: GitHub was only busy with another commit, so try again */
          if (now.sha === state.sha && attempt < 3) { await wait(700 * (attempt + 1)); continue; }
          state.sha = now.sha;
          state.menu = JSON.parse(dec.decode(now.bytes));
          render();
          throw UserError('The menu was changed from another device, so this page has been refreshed. Make your change again.');
        }
      }
    };
    return enqueue(run);
  }
  function findRest(m, rid) { return m.restaurants.filter(function (r) { return r.id === rid; })[0] || null; }
  function findSec(r, sid) { return r ? r.sections.filter(function (s) { return s.id === sid; })[0] || null : null; }
  function route() {
    var p = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    return { rid: p[0] || '', sid: p[1] || '' };
  }
  function photoSrc(path) { return freshPhotos[path] || ('../' + path); }
  function photosOf(it) { return it.photos && it.photos.length ? it.photos : (it.photo ? [it.photo] : []); }
  var MAX_EXTRA = 8;

  async function shrinkPhoto(file) {
    try {
      var src;
      try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) {
        src = await new Promise(function (ok, bad) {
          var im = new Image();
          im.onload = function () { ok(im); };
          im.onerror = function () { bad(new Error('unreadable')); };
          im.src = URL.createObjectURL(file);
        });
      }
      var w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
      var k = Math.min(1, 1400 / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      var ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(src, 0, 0, c.width, c.height);
      var blob = await new Promise(function (ok) { c.toBlob(ok, 'image/jpeg', 0.82); });
      if (!blob) throw new Error('no blob');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), url: URL.createObjectURL(blob) };
    } catch (e) {
      throw UserError('This photo could not be read. Choose a JPG or PNG photo.');
    }
  }

  /* ---------- screens before sign-in ---------- */
  function shell(inner) {
    return '<div class="gate"><img class="gate-logo" src="../assets/logos/century-marina.svg" alt="Century Marina Hotel"><div class="gate-card">' + inner + '</div></div>';
  }
  function renderLogin(auth) {
    app.innerHTML = shell(
      '<h1>Menu manager</h1><p class="sub">Log in to edit the restaurant menus.</p>' +
      '<form id="loginForm" novalidate>' +
      '<label class="field"><span>Username</span><input id="lUser" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>' +
      '<label class="field"><span>Password</span><input id="lPass" type="password" autocomplete="current-password" required></label>' +
      '<p class="form-error" id="loginError" role="alert" hidden></p>' +
      '<button class="btn btn--primary btn--wide" type="submit" id="loginBtn">Log in</button></form>');
    $('lUser').focus();
    $('loginForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var user = $('lUser').value, pass = $('lPass').value, err = $('loginError'), btn = $('loginBtn');
      err.hidden = true;
      if (!user.trim() || !pass) { err.textContent = 'Enter your username and password.'; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Logging in…';
      try {
        var token;
        try { token = await unseal(auth, user, pass); }
        catch (e) { throw UserError('Wrong username or password.'); }
        try { await connect(token, user.trim()); }
        catch (e) {
          if (e.status === 401) throw UserError('The access key for this menu has expired. Ask your web developer to renew it.');
          throw e;
        }
        setSession({ token: token, user: user.trim() });
        startApp();
      } catch (e) {
        err.textContent = explain(e); err.hidden = false;
        btn.disabled = false; btn.textContent = 'Log in';
      }
    });
  }
  function renderSetup(replacing) {
    app.innerHTML = shell(
      '<h1>' + (replacing ? 'Reset the admin login' : 'First-time setup') + '</h1>' +
      '<p class="sub">This is done once by the web developer. It creates the username and password the hotel will use.</p>' +
      '<form id="setupForm" novalidate>' +
      '<label class="field"><span>GitHub access key</span><input id="uToken" type="password" autocomplete="off" spellcheck="false" required>' +
      '<small>A fine-grained token for <b>' + esc(state.repo.owner + '/' + state.repo.repo) + '</b> with “Contents: Read and write”.</small></label>' +
      '<label class="field"><span>Choose a username</span><input id="uUser" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" required></label>' +
      '<label class="field"><span>Choose a password</span><input id="uPass" type="password" autocomplete="new-password" required><small>At least 10 characters.</small></label>' +
      '<label class="field"><span>Repeat the password</span><input id="uPass2" type="password" autocomplete="new-password" required></label>' +
      '<p class="form-error" id="setupError" role="alert" hidden></p>' +
      '<button class="btn btn--primary btn--wide" type="submit" id="setupBtn">Create the login</button></form>' +
      (replacing ? '<p class="gate-alt"><a href="./">Back to log in</a></p>' : ''));
    $('setupForm').addEventListener('submit', async function (ev) {
      ev.preventDefault();
      var token = $('uToken').value.trim(), user = $('uUser').value.trim(), pass = $('uPass').value, err = $('setupError'), btn = $('setupBtn');
      var problem = '';
      if (!token) problem = 'Paste the GitHub access key.';
      else if (user.length < 3) problem = 'Choose a username with at least 3 characters.';
      else if (pass.length < 10) problem = 'Choose a password with at least 10 characters.';
      else if (pass !== $('uPass2').value) problem = 'The two passwords are not the same.';
      err.hidden = true;
      if (problem) { err.textContent = problem; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = 'Checking the key…';
      try {
        try { await connect(token, user); }
        catch (e) {
          if (e.status === 401) throw UserError('GitHub did not accept this access key. Check that it was copied completely.');
          if (e.status === 404) throw UserError('This key cannot see the repository ' + state.repo.owner + '/' + state.repo.repo + '. Give it access to this repository.');
          throw e;
        }
        var sealed = await seal(user, pass, token);
        try { await writeFile(AUTH_PATH, enc.encode(JSON.stringify(sealed, null, 1) + '\n'), 'Set the admin login'); }
        catch (e) {
          if (e.status === 403 || e.status === 404) throw UserError('This key can read the repository but cannot write to it. Give it “Contents: Read and write”.');
          throw e;
        }
        setSession({ token: token, user: user });
        if (location.search) history.replaceState(null, '', location.pathname);
        startApp();
        toast('The login is ready. Keep the username and password somewhere safe.');
      } catch (e) {
        err.textContent = explain(e); err.hidden = false;
        btn.disabled = false; btn.textContent = 'Create the login';
      }
    });
  }

  /* ---------- the manager ---------- */
  function topbar() {
    return '<header class="top"><a class="top-brand" href="#/"><img src="../assets/logos/century-marina.svg" alt="Century Marina Hotel"><span>Menu manager</span></a>' +
      '<nav class="top-nav"><a class="btn btn--ghost btn--small" href="' + esc(siteUrl()) + '" target="_blank" rel="noopener">View menu</a>' +
      '<button class="btn btn--ghost btn--small" type="button" data-act="qr">QR code</button>' +
      '<details class="more"><summary class="btn btn--ghost btn--small" aria-label="Account">' + esc(state.user) + '</summary><div class="more-menu">' +
      '<button type="button" data-act="password">Change password</button><button type="button" data-act="logout">Log out</button></div></details></nav></header>';
  }
  function countItems(r) { return r.sections.reduce(function (n, s) { return n + s.items.length; }, 0); }

  function viewDashboard() {
    var tiles = state.menu.restaurants.map(function (r) {
      if (r.soon) {
        return '<div class="tile tile--soon"><span class="tile-logo">Coming soon</span>' +
          '<span class="tile-info"><strong>New restaurant</strong><span>Shown to guests as “Coming soon”. It opens here once the brand is ready.</span></span></div>';
      }
      return '<a class="tile tile--' + esc(r.theme) + '" href="#/' + encodeURIComponent(r.id) + '">' +
        '<span class="tile-logo"><img src="../' + esc(r.logo) + '" alt=""></span>' +
        '<span class="tile-info"><strong>' + esc(en(r.name)) + '</strong><span>' + plural(countItems(r), 'product', 'products') + ' in ' + plural(r.sections.length, 'section', 'sections') + '</span></span></a>';
    }).join('');
    return '<main class="page"><h1>Restaurants</h1><p class="sub">Choose a restaurant to edit its menu.</p><div class="tiles">' + tiles + '</div>' +
      '<p class="note">Changes appear on the guest menu about a minute after you publish them.</p></main>';
  }
  function viewRestaurant(r) {
    var rows = r.sections.map(function (s) {
      return '<li class="row row--section"><a class="row-main" href="#/' + encodeURIComponent(r.id) + '/' + encodeURIComponent(s.id) + '">' +
        '<strong>' + esc(en(s.name)) + '</strong><span>' + plural(s.items.length, 'product', 'products') + '</span></a>' +
        '<button class="link" type="button" data-act="rename-section" data-sid="' + esc(s.id) + '">Rename</button>' +
        '<button class="link link--danger" type="button" data-act="delete-section" data-sid="' + esc(s.id) + '">Delete</button></li>';
    }).join('');
    return '<main class="page"><a class="crumb" href="#/">All restaurants</a>' +
      '<div class="page-head"><h1>' + esc(en(r.name)) + '</h1><button class="btn btn--primary" type="button" data-act="add-section">Add section</button></div>' +
      '<p class="sub">Open a section to add or edit its products.</p>' +
      (rows ? '<ul class="list">' + rows + '</ul>' : '<p class="blank">This restaurant has no sections yet. Add one to start its menu.</p>') + '</main>';
  }
  function itemRow(it, cur) {
    var thumb = it.photo ? '<img src="' + esc(photoSrc(it.photo)) + '" alt="" loading="lazy">' : '<span class="nophoto">No photo</span>';
    return '<li class="row row--item' + (it.available === false ? ' is-off' : '') + '">' +
      '<button class="thumb" type="button" data-act="edit" data-id="' + esc(it.id) + '" aria-label="Edit ' + esc(en(it.title)) + '">' + thumb + '</button>' +
      '<div class="row-text"><strong>' + esc(en(it.title)) + (it.main ? '<span class="badge">Main plate</span>' : '') + '</strong>' + (en(it.desc) ? '<span class="row-desc">' + esc(en(it.desc)) + '</span>' : '') + '</div>' +
      '<span class="row-price">' + (money(it.price) === '' ? '<small>No price</small>' : esc(money(it.price)) + ' <small>' + esc(cur) + '</small>') + '</span>' +
      '<label class="switch" title="Available today"><input type="checkbox" data-act="toggle" data-id="' + esc(it.id) + '"' + (it.available === false ? '' : ' checked') + '><span class="switch-ui"></span><span class="switch-label">Available</span></label>' +
      '<button class="btn btn--ghost btn--small" type="button" data-act="edit" data-id="' + esc(it.id) + '">Edit</button></li>';
  }
  function viewSection(r, s) {
    var cur = en(state.menu.currency);
    var blocks = [];
    var mains = s.items.filter(function (it) { return it.main; });
    if (mains.length) blocks.push({ name: 'Main plate (shown large at the top)', items: mains });
    var loose = s.items.filter(function (it) { return !it.main && (!it.group || !(s.groups || []).some(function (g) { return g.id === it.group; })); });
    if (loose.length) blocks.push({ name: mains.length ? 'No group' : '', items: loose });
    (s.groups || []).forEach(function (g) {
      var list = s.items.filter(function (it) { return !it.main && it.group === g.id; });
      if (list.length) blocks.push({ name: en(g.name), items: list });
    });
    var body = blocks.map(function (b) {
      return (b.name ? '<h2 class="group-name">' + esc(b.name) + '</h2>' : '') + '<ul class="list">' + b.items.map(function (it) { return itemRow(it, cur); }).join('') + '</ul>';
    }).join('');
    return '<main class="page"><a class="crumb" href="#/' + encodeURIComponent(r.id) + '">' + esc(en(r.name)) + '</a>' +
      '<div class="page-head"><h1>' + esc(en(s.name)) + '</h1><button class="btn btn--primary" type="button" data-act="add">Add product</button></div>' +
      '<p class="sub">' + (s.items.length ? plural(s.items.length, 'product', 'products') + ' on the menu.' : 'Nothing here yet.') + '</p>' +
      (body || '<p class="blank">Add the first product. Guests see it here as soon as you publish.</p>') + '</main>';
  }
  function render() {
    if (!state.menu) return;
    var rt = route();
    var r = rt.rid ? findRest(state.menu, rt.rid) : null;
    if (r && r.soon) r = null;
    var s = r && rt.sid ? findSec(r, rt.sid) : null;
    var body;
    if (!rt.rid) body = viewDashboard();
    else if (r && !rt.sid) body = viewRestaurant(r);
    else if (r && s) body = viewSection(r, s);
    else { location.hash = '#/'; return; }
    app.innerHTML = topbar() + body;
  }
  function startApp() {
    render();
    window.scrollTo(0, 0);
  }

  /* ---------- dialogs ---------- */
  function openDlg(d) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  document.addEventListener('click', function (ev) {
    var c = ev.target.closest('[data-close]');
    if (c) c.closest('dialog').close();
  });
  function confirmBox(title, text, yesLabel) {
    return new Promise(function (ok) {
      var d = $('confirmDlg');
      $('confirmTitle').textContent = title;
      $('confirmText').textContent = text;
      $('confirmYes').textContent = yesLabel || 'Delete';
      var done = function (v) { d.close(); $('confirmYes').onclick = $('confirmNo').onclick = d.oncancel = null; ok(v); };
      $('confirmYes').onclick = function () { done(true); };
      $('confirmNo').onclick = function () { done(false); };
      d.oncancel = function () { done(false); };
      openDlg(d);
    });
  }

  /* product: add and edit */
  var editing = null;  // { rid, sid, id | null, photo: 'keep' | 'new' | 'remove', file }
  function setPreview(src) {
    var img = $('photoPreview');
    if (src) { img.src = src; img.hidden = false; $('photoEmpty').hidden = true; $('photoRemove').hidden = false; }
    else { img.removeAttribute('src'); img.hidden = true; $('photoEmpty').hidden = false; $('photoRemove').hidden = true; }
  }
  function openProduct(id) {
    var rt = route(), r = findRest(state.menu, rt.rid), s = findSec(r, rt.sid);
    if (!s) return;
    var it = id ? s.items.filter(function (x) { return x.id === id; })[0] : null;
    editing = { rid: r.id, sid: s.id, id: it ? it.id : null, photo: 'keep', file: null,
      extras: it ? photosOf(it).slice(1).map(function (p) { return { path: p, url: photoSrc(p) }; }) : [] };
    $('productForm').reset();
    $('productTitle').textContent = it ? 'Edit product' : 'Add product';
    $('productSave').textContent = it ? 'Save changes' : 'Publish';
    $('productDelete').hidden = !it;
    $('productError').hidden = true;
    $('fCur').textContent = en(state.menu.currency);
    var opts = '<option value="">No group</option>' + (s.groups || []).map(function (g) { return '<option value="' + esc(g.id) + '">' + esc(en(g.name)) + '</option>'; }).join('') + '<option value="__new">New group…</option>';
    $('fGroup').innerHTML = opts;
    var key = r.id + '/' + s.id;
    var g = it ? (it.group || '') : (lastGroup[key] || ((s.groups || [])[0] || {}).id || '');
    $('fGroup').value = (s.groups || []).some(function (x) { return x.id === g; }) ? g : '';
    $('newGroup').hidden = true;
    $('fTitleEn').value = it ? (it.title.en || '') : '';
    $('fTitleAr').value = it ? (it.title.ar || '') : '';
    $('fDescEn').value = it ? ((it.desc || {}).en || '') : '';
    $('fDescAr').value = it ? ((it.desc || {}).ar || '') : '';
    $('fPrice').value = it && it.price !== '' && it.price != null ? it.price : '';
    $('fAvail').checked = it ? it.available !== false : true;
    $('fMain').checked = !!(it && it.main);
    $('extrasBox').hidden = !$('fMain').checked;
    drawExtras();
    $('arabicBox').open = !!(it && (it.title.ar || (it.desc || {}).ar));
    setPreview(it && it.photo ? photoSrc(it.photo) : '');
    openDlg($('productDlg'));
    if (!it) $('fTitleEn').focus();
  }
  function drawExtras() {
    if (!editing) return;
    var html = editing.extras.map(function (x, i) {
      return '<div class="extra"><img src="' + esc(x.url) + '" alt=""><button type="button" data-extra="' + i + '" aria-label="Remove this photo">&times;</button></div>';
    }).join('');
    if (editing.extras.length < MAX_EXTRA) html += '<button class="extra-add" type="button" id="extrasAdd">Add photos</button>';
    $('extrasGrid').innerHTML = html;
  }
  $('fMain').addEventListener('change', function () { $('extrasBox').hidden = !this.checked; });
  $('extrasGrid').addEventListener('click', function (ev) {
    if (!editing) return;
    if (ev.target.closest('#extrasAdd')) { $('extrasInput').click(); return; }
    var rm = ev.target.closest('[data-extra]');
    if (rm) { editing.extras.splice(Number(rm.dataset.extra), 1); drawExtras(); }
  });
  $('extrasInput').addEventListener('change', function () {
    if (!editing) return;
    var files = Array.prototype.slice.call(this.files || []);
    for (var i = 0; i < files.length && editing.extras.length < MAX_EXTRA; i++) {
      editing.extras.push({ file: files[i], url: URL.createObjectURL(files[i]) });
    }
    this.value = '';
    drawExtras();
  });
  $('fGroup').addEventListener('change', function () {
    var isNew = this.value === '__new';
    $('newGroup').hidden = !isNew;
    if (isNew) $('fGroupEn').focus();
  });
  $('photoInput').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f || !editing) return;
    editing.photo = 'new'; editing.file = f;
    setPreview(URL.createObjectURL(f));
  });
  $('photoRemove').addEventListener('click', function () {
    if (!editing) return;
    editing.photo = 'remove'; editing.file = null; $('photoInput').value = '';
    setPreview('');
  });
  function productBusy(on, label) {
    $('productSave').disabled = on; $('productDelete').disabled = on;
    if (label) $('productSave').textContent = label;
  }
  var saving = false;
  $('productForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (!editing || saving) return;
    var e = editing, err = $('productError');
    var titleEn = $('fTitleEn').value.trim(), priceRaw = $('fPrice').value.trim(), price = Math.round(Number(priceRaw) * 100) / 100;
    var picked = $('fGroup').value, group = picked, newEn = $('fGroupEn').value.trim(), newAr = $('fGroupAr').value.trim();
    var titleAr = $('fTitleAr').value.trim(), descEn = $('fDescEn').value.trim(), descAr = $('fDescAr').value.trim(), avail = $('fAvail').checked;
    var isMain = $('fMain').checked, extras = isMain ? e.extras.slice() : [], uploaded = [], dropped = [];
    var problem = '';
    if (!titleEn) problem = 'Enter a title for the product.';
    else if (priceRaw === '' || !isFinite(price) || price < 0) problem = 'Enter the price as a number, for example 65.';
    else if (picked === '__new' && !newEn) problem = 'Enter a name for the new group, or pick an existing group.';
    err.hidden = true;
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    var doneLabel = e.id ? 'Save changes' : 'Publish';
    var newPath = null, oldPath = null;
    saving = true;
    productBusy(true, e.id ? 'Saving…' : 'Publishing…');
    try {
      var id = e.id || uid('p');
      newPath = null; oldPath = null;
      if (e.photo === 'new') {
        var small = await shrinkPhoto(e.file);
        newPath = 'images/' + e.rid + '/' + id + '-' + Date.now().toString(36) + '.jpg';
        await writeFile(newPath, small.bytes, 'Add photo for ' + titleEn);
        freshPhotos[newPath] = small.url;
        uploaded.push(newPath);
      }
      var extraPaths = [];
      for (var x = 0; x < extras.length; x++) {
        if (extras[x].path) { extraPaths.push(extras[x].path); continue; }
        var sm = await shrinkPhoto(extras[x].file);
        var xp = 'images/' + e.rid + '/' + id + '-' + Date.now().toString(36) + '-' + (x + 1) + '.jpg';
        await writeFile(xp, sm.bytes, 'Add photo for ' + titleEn);
        freshPhotos[xp] = sm.url;
        uploaded.push(xp);
        extraPaths.push(xp);
      }
      await commit((e.id ? 'Update ' : 'Add ') + titleEn, function (m) {
        var s = findSec(findRest(m, e.rid), e.sid);
        if (!s) throw UserError('This section no longer exists. Go back and try again.');
        group = picked;
        if (picked === '__new') {
          var existing = (s.groups || []).filter(function (g) { return en(g.name).toLowerCase() === newEn.toLowerCase(); })[0];
          if (existing) group = existing.id;
          else {
            var gid = slug(newEn) || uid('g');
            while ((s.groups || []).some(function (g) { return g.id === gid; })) gid = uid('g');
            s.groups = (s.groups || []).concat([{ id: gid, name: { en: newEn, ar: newAr } }]);
            group = gid;
          }
        }
        var it = e.id ? s.items.filter(function (x) { return x.id === e.id; })[0] : null;
        if (e.id && !it) throw UserError('This product was deleted from another device.');
        if (!it) { it = { id: id, photo: '' }; s.items.push(it); }
        oldPath = it.photo || null;
        var before = photosOf(it);
        var cover = e.photo === 'new' ? newPath : (e.photo === 'remove' ? '' : (it.photo || ''));
        var photos = (cover ? [cover] : []).concat(extraPaths);
        dropped = before.filter(function (p) { return photos.indexOf(p) === -1; });
        it.photo = photos[0] || '';
        if (isMain) { it.main = true; it.photos = photos; } else { delete it.main; delete it.photos; }
        it.group = group;
        it.title = { en: titleEn, ar: titleAr };
        it.desc = { en: descEn, ar: descAr };
        it.price = price;
        it.available = avail;
      });
      lastGroup[e.rid + '/' + e.sid] = group;
      dropped.forEach(function (p) { removeFile(p, 'Remove old photo'); });
      $('productDlg').close();
      render();
      toast(e.id ? 'Saved. The menu updates in about a minute.' : 'Published. It appears on the menu in about a minute.');
    } catch (x) {
      err.textContent = explain(x); err.hidden = false;
      /* the photo was uploaded but the product was not saved: do not leave the file behind */
      var saved = (findSec(findRest(state.menu, e.rid), e.sid) || { items: [] }).items.filter(function (i) { return i.id === id; })[0];
      var inUse = saved ? photosOf(saved) : [];
      uploaded.forEach(function (p) { if (inUse.indexOf(p) === -1) removeFile(p, 'Remove unused photo'); });
    }
    saving = false;
    productBusy(false, doneLabel);
  });
  $('productDelete').addEventListener('click', async function () {
    if (!editing || !editing.id) return;
    var e = editing;
    var s = findSec(findRest(state.menu, e.rid), e.sid);
    var it = s && s.items.filter(function (x) { return x.id === e.id; })[0];
    if (!it) return;
    if (!(await confirmBox('Delete this product?', '“' + en(it.title) + '” will be removed from the menu. This cannot be undone.'))) return;
    productBusy(true);
    try {
      await commit('Delete ' + en(it.title), function (m) {
        var sec = findSec(findRest(m, e.rid), e.sid);
        sec.items = sec.items.filter(function (x) { return x.id !== e.id; });
      });
      photosOf(it).forEach(function (p) { removeFile(p, 'Remove photo'); });
      $('productDlg').close();
      render();
      toast('Deleted.');
    } catch (x) {
      $('productError').textContent = explain(x); $('productError').hidden = false;
    }
    productBusy(false);
  });

  /* section: add and rename */
  var sectionEdit = null;
  function openSection(sid) {
    var r = findRest(state.menu, route().rid);
    var s = sid ? findSec(r, sid) : null;
    sectionEdit = { rid: r.id, sid: s ? s.id : null };
    $('sectionForm').reset();
    $('sectionError').hidden = true;
    $('sectionTitle').textContent = s ? 'Rename section' : 'Add section';
    $('sectionSave').textContent = s ? 'Save name' : 'Add section';
    if (s) { $('sNameEn').value = s.name.en || ''; $('sNameAr').value = s.name.ar || ''; }
    openDlg($('sectionDlg'));
    $('sNameEn').focus();
  }
  $('sectionForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var e = sectionEdit, nameEn = $('sNameEn').value.trim(), nameAr = $('sNameAr').value.trim(), err = $('sectionError'), btn = $('sectionSave');
    err.hidden = true;
    if (!nameEn) { err.textContent = 'Enter a name for the section.'; err.hidden = false; return; }
    var r = findRest(state.menu, e.rid);
    if (r.sections.some(function (s) { return s.id !== e.sid && en(s.name).toLowerCase() === nameEn.toLowerCase(); })) {
      err.textContent = 'This restaurant already has a section called “' + nameEn + '”.'; err.hidden = false; return;
    }
    var label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await commit((e.sid ? 'Rename section to ' : 'Add section ') + nameEn, function (m) {
        var rest = findRest(m, e.rid);
        if (e.sid) { var s = findSec(rest, e.sid); if (s) s.name = { en: nameEn, ar: nameAr }; return; }
        var id = slug(nameEn) || uid('s');
        while (rest.sections.some(function (s) { return s.id === id; })) id = uid('s');
        rest.sections.push({ id: id, name: { en: nameEn, ar: nameAr }, groups: [], items: [] });
      });
      $('sectionDlg').close();
      render();
      toast(e.sid ? 'Section renamed.' : 'Section added. Open it to add products.');
    } catch (x) { err.textContent = explain(x); err.hidden = false; }
    btn.disabled = false; btn.textContent = label;
  });
  async function deleteSection(sid) {
    var rid = route().rid, r = findRest(state.menu, rid), s = findSec(r, sid);
    if (!s) return;
    var n = s.items.length;
    var text = n ? 'The section and its ' + plural(n, 'product', 'products') + ' will be removed from the menu. This cannot be undone.' : 'The section will be removed from the menu.';
    if (!(await confirmBox('Delete “' + en(s.name) + '”?', text))) return;
    try {
      await commit('Delete section ' + en(s.name), function (m) {
        var rest = findRest(m, rid);
        rest.sections = rest.sections.filter(function (x) { return x.id !== sid; });
      });
      s.items.forEach(function (it) { photosOf(it).forEach(function (p) { removeFile(p, 'Remove photo'); }); });
      render();
      toast('Section deleted.');
    } catch (x) { toast(explain(x), 'error'); }
  }

  /* QR code */
  function drawQr() {
    var url = $('qrTarget').value;
    var qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    var n = qr.getModuleCount(), quiet = 4, c = $('qrCanvas'), ctx = c.getContext('2d');
    var cell = Math.floor(c.width / (n + quiet * 2)), off = Math.floor((c.width - cell * n) / 2);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) if (qr.isDark(y, x)) ctx.fillRect(off + x * cell, off + y * cell, cell, cell);
    $('qrUrl').textContent = url;
  }
  function openQr() {
    var base = siteUrl();
    $('qrTarget').innerHTML = '<option value="' + esc(base) + '">The hotel page with all restaurants</option>' +
      state.menu.restaurants.filter(function (r) { return !r.soon; }).map(function (r) { return '<option value="' + esc(base + '#/' + encodeURIComponent(r.id)) + '">' + esc(en(r.name)) + ' only</option>'; }).join('');
    drawQr();
    openDlg($('qrDlg'));
  }
  $('qrTarget').addEventListener('change', drawQr);
  $('qrDownload').addEventListener('click', function () {
    $('qrCanvas').toBlob(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'menu-qr-code.png';
      document.body.appendChild(a); a.click(); a.remove();
    }, 'image/png');
  });
  $('qrCopy').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText($('qrTarget').value); toast('Link copied.'); }
    catch (e) { toast('Copy the link shown under the QR code.', 'error'); }
  });

  /* password */
  $('passForm').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var a = $('pNew').value, err = $('passError'), btn = $('passSave');
    err.hidden = true;
    var problem = a.length < 10 ? 'Choose a password with at least 10 characters.' : (a !== $('pNew2').value ? 'The two passwords are not the same.' : '');
    if (problem) { err.textContent = problem; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      var sealed = await seal(state.user, a, state.gh.token);
      await writeFile(AUTH_PATH, enc.encode(JSON.stringify(sealed, null, 1) + '\n'), 'Change the admin password');
      $('passDlg').close();
      toast('Password changed. Use the new one next time you log in.');
    } catch (x) { err.textContent = explain(x); err.hidden = false; }
    btn.disabled = false; btn.textContent = 'Change password';
  });

  /* ---------- clicks inside the manager ---------- */
  app.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-act]');
    if (!b || b.tagName === 'INPUT') return;
    var act = b.dataset.act;
    var more = b.closest('details'); if (more) more.open = false;
    if (act === 'add') openProduct(null);
    else if (act === 'edit') openProduct(b.dataset.id);
    else if (act === 'add-section') openSection(null);
    else if (act === 'rename-section') openSection(b.dataset.sid);
    else if (act === 'delete-section') deleteSection(b.dataset.sid);
    else if (act === 'qr') openQr();
    else if (act === 'password') { $('passForm').reset(); $('passError').hidden = true; openDlg($('passDlg')); }
    else if (act === 'logout') { setSession(null); location.hash = ''; location.reload(); }
  });
  app.addEventListener('change', async function (ev) {
    var box = ev.target.closest('input[data-act="toggle"]');
    if (!box) return;
    var rt = route(), id = box.dataset.id, on = box.checked;
    var cur = findSec(findRest(state.menu, rt.rid), rt.sid);
    var curIt = cur && cur.items.filter(function (x) { return x.id === id; })[0];
    box.disabled = true;
    try {
      await commit((on ? 'Mark available: ' : 'Mark unavailable: ') + (curIt ? en(curIt.title) : id), function (m) {
        var s = findSec(findRest(m, rt.rid), rt.sid);
        var it = s && s.items.filter(function (x) { return x.id === id; })[0];
        if (!it) throw UserError('This product was deleted from another device.');
        it.available = on;
      });
      render();
      toast(on ? 'Marked as available.' : 'Marked as not available today.');
    } catch (x) {
      box.checked = !on; box.disabled = false;
      toast(explain(x), 'error');
    }
  });
  window.addEventListener('hashchange', function () {
    if (!state.menu) return;
    Array.prototype.forEach.call(document.querySelectorAll('dialog[open]'), function (d) { d.close(); });
    render();
    window.scrollTo(0, 0);
  });
  document.addEventListener('click', function (ev) {
    var open = document.querySelector('.more[open]');
    if (open && !open.contains(ev.target)) open.open = false;
  });

  /* ---------- start ---------- */
  async function boot() {
    state.repo = detectRepo();
    if (!state.repo) {
      app.innerHTML = shell('<h1>Menu manager</h1><p class="sub">This page is not connected to a menu yet. Open it from the hotel’s menu address, or fill in <code>admin/config.js</code>.</p>');
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      app.innerHTML = shell('<h1>Menu manager</h1><p class="sub">Open this page with <b>https://</b> at the start of the address. The login only works on a secure connection.</p>');
      return;
    }
    var saved = getSession();
    if (saved && saved.token && !/[?&]setup\b/.test(location.search)) {
      try { await connect(saved.token, saved.user); startApp(); return; }
      catch (e) {
        if (e.status !== 401 && e.status !== 403 && e.status !== 404) {
          app.innerHTML = shell('<h1>Menu manager</h1><p class="sub">' + esc(explain(e)) + '</p><button class="btn btn--primary btn--wide" type="button" onclick="location.reload()">Try again</button>');
          return;
        }
        setSession(null);
      }
    }
    var auth = null;
    try { auth = await loadAuth(); }
    catch (e) {
      app.innerHTML = shell('<h1>Menu manager</h1><p class="sub">No connection. Check the internet and reload this page.</p>');
      return;
    }
    if (!auth || /[?&]setup\b/.test(location.search)) renderSetup(!!auth);
    else renderLogin(auth);
  }
  boot();
})();
