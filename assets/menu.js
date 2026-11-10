/* Century Marina Hotel · guest menu
   Reads data/menu.json and draws three screens:
   #/                 the hotel landing with the three restaurants
   #/<restaurant>     the sections of one restaurant
   #/<restaurant>/<section>   the items of one section */
(function () {
  'use strict';

  var view = document.getElementById('view');
  var back = document.getElementById('back');
  var backLabel = document.getElementById('backLabel');
  var mark = document.getElementById('mark');
  var langBtn = document.getElementById('lang');
  var zoom = document.getElementById('zoom');
  var themeMeta = document.querySelector('meta[name="theme-color"]');

  var THEME_COLOR = { hotel: '#ffffff', north: '#163340', regions: '#fbfbf8', knife: '#220409' };
  var TEXT = {
    en: {
      lead: 'Choose a restaurant',
      back: 'Back',
      restaurants: 'Restaurants',
      soon: 'This menu is on its way',
      soonText: 'Please ask our team for today’s selection.',
      off: 'Not available today',
      photo: 'View photo of ',
      jump: 'Jump to',
      missing: 'We couldn’t find that page.',
      home: 'See all restaurants',
      fail: 'The menu couldn’t be loaded. Check your connection and try again.',
      retry: 'Try again',
      close: 'Close'
    },
    ar: {
      lead: 'اختر المطعم',
      back: 'رجوع',
      restaurants: 'المطاعم',
      soon: 'القائمة قيد التحضير',
      soonText: 'يسعد فريقنا بإطلاعكم على أصناف اليوم.',
      off: 'غير متوفر اليوم',
      photo: 'عرض صورة ',
      jump: 'انتقل إلى',
      missing: 'لم نعثر على هذه الصفحة.',
      home: 'عرض جميع المطاعم',
      fail: 'تعذر تحميل القائمة. تحقق من الاتصال وحاول مرة أخرى.',
      retry: 'إعادة المحاولة',
      close: 'إغلاق'
    }
  };

  var data = null;
  var lang = 'en';
  try { if (localStorage.getItem('cm_lang') === 'ar') lang = 'ar'; } catch (e) { /* private mode */ }
  var firstPaint = true;
  var observer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* pick the text for the current language, falling back to the other one */
  function tx(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    return o[lang] || o.en || o.ar || '';
  }
  function t(k) { return TEXT[lang][k]; }
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return esc(n);
    return v % 1 === 0 ? String(v) : v.toFixed(2);
  }
  function priceHtml(n) {
    if (n === '' || n == null) return '';
    return '<span class="price-n">' + money(n) + '</span> <small>' + esc(tx(data.currency)) + '</small>';
  }

  function applyLang() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    langBtn.textContent = lang === 'ar' ? 'English' : 'عربي';
    langBtn.lang = lang === 'ar' ? 'en' : 'ar';
    backLabel.textContent = t('back');
    document.getElementById('zoomClose').setAttribute('aria-label', t('close'));
  }

  function route() {
    var parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    return { rid: parts[0] || '', sid: parts[1] || '' };
  }
  function find(list, id) {
    for (var i = 0; i < (list || []).length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function setChrome(theme, backHref, markRest, title) {
    document.body.dataset.theme = theme;
    if (themeMeta) themeMeta.content = THEME_COLOR[theme] || '#ffffff';
    back.hidden = !backHref;
    if (backHref) back.href = backHref;
    mark.hidden = !markRest;
    if (markRest) {
      mark.href = '#/' + encodeURIComponent(markRest.id);
      mark.innerHTML = '<img src="' + esc(markRest.logo) + '" alt="' + esc(tx(markRest.name)) + '">';
    }
    document.title = title;
  }

  var WAVE = '<svg class="door-wave" viewBox="0 0 400 22" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0h400v8c-34 16-66 16-100 4s-66-12-100 0-66 12-100 0S34-4 0 8z"/></svg>';

  function drawHome() {
    var hotel = data.hotel || {};
    setChrome('hotel', '', null, tx(hotel.name));
    var doors = (data.restaurants || []).map(function (r) {
      var label = tx(r.name) + (tx(r.tagline) ? ', ' + tx(r.tagline) : '');
      return '<a class="door door--' + esc(r.theme) + '" href="#/' + encodeURIComponent(r.id) + '">' + WAVE +
        '<img src="' + esc(r.logo) + '" alt="' + esc(label) + '"></a>';
    }).join('');
    return '<section class="home">' +
      '<div class="home-top"><h1 style="margin:0"><img class="home-logo" src="' + esc(hotel.logo) + '" alt="' + esc(tx(hotel.name)) + ', ' + esc(tx(hotel.place)) + '"></h1>' +
      '<p class="home-lead">' + t('lead') + '</p></div>' +
      '<nav class="doors" aria-label="' + t('restaurants') + '">' + doors + '</nav></section>';
  }

  function drawRestaurant(r) {
    setChrome(r.theme, '#/', null, tx(r.name) + ' · ' + tx(data.hotel.name));
    var label = tx(r.name) + (tx(r.tagline) ? ', ' + tx(r.tagline) : '');
    var secs = (r.sections || []).map(function (s) {
      return '<a class="sec" href="#/' + encodeURIComponent(r.id) + '/' + encodeURIComponent(s.id) + '">' +
        '<span class="sec-name">' + esc(tx(s.name)) + '</span><span class="chev" aria-hidden="true"></span></a>';
    }).join('');
    if (!secs) secs = emptyHtml();
    return '<section class="rest"><h1 style="margin:0"><img class="rest-logo" src="' + esc(r.logo) + '" alt="' + esc(label) + '"></h1>' +
      '<nav class="secs">' + secs + '</nav></section>';
  }

  function emptyHtml() {
    return '<div class="empty"><strong>' + t('soon') + '</strong>' + t('soonText') + '</div>';
  }

  function itemHtml(it) {
    var name = tx(it.title);
    var desc = tx(it.desc);
    var off = it.available === false;
    var photo = it.photo
      ? '<button class="item-ph" type="button" data-zoom="' + esc(it.id) + '" aria-label="' + esc(t('photo') + name) + '"><img src="' + esc(it.photo) + '" alt="" loading="lazy" decoding="async"></button>'
      : '';
    return '<article class="item' + (off ? ' item-off' : '') + '">' + photo +
      '<div class="item-body"><div class="item-row"><h3 class="item-name">' + esc(name) + '</h3><span class="item-lead" aria-hidden="true"></span>' +
      '<p class="price">' + priceHtml(it.price) + '</p></div>' +
      (desc ? '<p class="item-desc">' + esc(desc) + '</p>' : '') +
      (off ? '<span class="item-flag">' + t('off') + '</span>' : '') +
      '</div></article>';
  }

  function drawSection(r, s) {
    setChrome(r.theme, '#/' + encodeURIComponent(r.id), r, tx(s.name) + ' · ' + tx(r.name));
    var items = s.items || [];
    var blocks = [];
    var loose = items.filter(function (it) { return !it.group || !find(s.groups, it.group); });
    if (loose.length) blocks.push({ id: '', name: '', items: loose });
    (s.groups || []).forEach(function (g) {
      var list = items.filter(function (it) { return it.group === g.id; });
      if (list.length) blocks.push({ id: g.id, name: tx(g.name), items: list });
    });
    var named = blocks.filter(function (b) { return b.name; });
    var chips = named.length > 1
      ? '<nav class="chips" aria-label="' + t('jump') + '">' + named.map(function (b) {
          return '<button class="chip" type="button" data-jump="g-' + esc(b.id) + '">' + esc(b.name) + '</button>';
        }).join('') + '</nav>'
      : '';
    var body = blocks.map(function (b) {
      return '<section class="group" id="g-' + esc(b.id) + '">' +
        (b.name ? '<h2 class="group-title">' + esc(b.name) + '</h2>' : '') +
        '<div class="items">' + b.items.map(itemHtml).join('') + '</div></section>';
    }).join('');
    if (!blocks.length) body = emptyHtml();
    return '<section class="menu"><header class="menu-head"><h1>' + esc(tx(s.name)) + '</h1></header>' + chips + body +
      '<p class="foot">' + esc(tx(r.name)) + ' · ' + esc(tx(data.hotel.name)) + '</p></section>';
  }

  function watchGroups() {
    if (observer) { observer.disconnect(); observer = null; }
    var chips = view.querySelector('.chips');
    if (!chips || !('IntersectionObserver' in window)) return;
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var all = chips.querySelectorAll('.chip');
        for (var i = 0; i < all.length; i++) {
          var on = all[i].dataset.jump === e.target.id;
          if (on) {
            all[i].setAttribute('aria-current', 'true');
            chips.scrollTo({ left: all[i].offsetLeft - chips.clientWidth / 2 + all[i].offsetWidth / 2, behavior: 'smooth' });
          } else all[i].removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-120px 0px -70% 0px' });
    view.querySelectorAll('.group').forEach(function (g) { observer.observe(g); });
  }

  function draw(keepScroll) {
    if (!data) return;
    var r = route();
    var html;
    var rest = r.rid ? find(data.restaurants, r.rid) : null;
    var sec = rest && r.sid ? find(rest.sections, r.sid) : null;
    if (!r.rid) html = drawHome();
    else if (rest && !r.sid) html = drawRestaurant(rest);
    else if (rest && sec) html = drawSection(rest, sec);
    else {
      setChrome('hotel', '#/', null, tx(data.hotel.name));
      html = '<p class="state">' + t('missing') + '<button type="button" data-home>' + t('home') + '</button></p>';
    }
    view.innerHTML = html;
    view.classList.remove('view-in');
    if (!firstPaint) { void view.offsetWidth; view.classList.add('view-in'); }
    firstPaint = false;
    if (!keepScroll) window.scrollTo(0, 0);
    watchGroups();
  }

  view.addEventListener('click', function (e) {
    var jump = e.target.closest('[data-jump]');
    if (jump) {
      var el = document.getElementById(jump.dataset.jump);
      if (el) el.scrollIntoView({ block: 'start' });
      return;
    }
    if (e.target.closest('[data-home]')) { location.hash = '#/'; return; }
    if (e.target.closest('[data-retry]')) { load(); return; }
    var z = e.target.closest('[data-zoom]');
    if (z) {
      var r = route();
      var rest = find(data.restaurants, r.rid);
      var sec = rest && find(rest.sections, r.sid);
      var it = sec && find(sec.items, z.dataset.zoom);
      if (!it) return;
      document.getElementById('zoomImg').src = it.photo;
      document.getElementById('zoomImg').alt = tx(it.title);
      document.getElementById('zoomTitle').textContent = tx(it.title);
      document.getElementById('zoomDesc').textContent = tx(it.desc);
      document.getElementById('zoomDesc').hidden = !tx(it.desc);
      document.getElementById('zoomPrice').innerHTML = priceHtml(it.price);
      if (zoom.showModal) zoom.showModal(); else zoom.setAttribute('open', '');
    }
  });
  document.getElementById('zoomClose').addEventListener('click', function () { zoom.close(); });
  zoom.addEventListener('click', function (e) { if (e.target === zoom) zoom.close(); });

  langBtn.addEventListener('click', function () {
    lang = lang === 'ar' ? 'en' : 'ar';
    try { localStorage.setItem('cm_lang', lang); } catch (e) { /* private mode */ }
    applyLang();
    draw(true);
  });
  window.addEventListener('hashchange', function () { if (zoom.open) zoom.close(); draw(false); });

  function load() {
    view.innerHTML = '<p class="state">' + (lang === 'ar' ? 'جارٍ تحميل القائمة…' : 'Loading the menu…') + '</p>';
    /* the stamp changes every minute, so guests always get a menu at most a minute old */
    fetch('data/menu.json?v=' + Math.floor(Date.now() / 60000), { cache: 'no-cache' })
      .then(function (res) { if (!res.ok) throw new Error(res.status); return res.json(); })
      .then(function (json) { data = json; draw(false); })
      .catch(function () {
        view.innerHTML = '<p class="state">' + t('fail') + '<button type="button" data-retry>' + t('retry') + '</button></p>';
      });
  }

  applyLang();
  load();
})();
