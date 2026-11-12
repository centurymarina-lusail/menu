/* Century Marina Hotel · guest menu
   Reads data/menu.json and draws three screens:
   #/                 the hotel landing with the restaurants
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

  /* browser bar colour and landing "door" colour for each look */
  var THEME_COLOR = { hotel: '#ffffff', north: '#163340', regions: '#fbfbf8', knife: '#724b4e', room: '#ffffff' };
  var DOOR_COLOR = { north: '#163340', regions: '#e9f0ed', knife: '#220409', room: '#f1f4f6', soon: '#efe6d3' };
  /* looks that use photo tiles, banners, cards and a search box */
  var RICH = { knife: true };

  var TEXT = {
    en: {
      lead: 'Choose a restaurant',
      back: 'Back',
      restaurants: 'Restaurants',
      soon: 'This menu is on its way',
      soonText: 'Please ask our team for today’s selection.',
      comingSoon: 'Coming soon',
      newRestaurant: 'A new restaurant',
      off: 'Not available today',
      photo: 'View photo of ',
      jump: 'Jump to',
      search: 'Search',
      noResults: 'Nothing matches your search.',
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
      comingSoon: 'قريباً',
      newRestaurant: 'مطعم جديد',
      off: 'غير متوفر اليوم',
      photo: 'عرض صورة ',
      jump: 'انتقل إلى',
      search: 'بحث',
      noResults: 'لا توجد نتائج مطابقة.',
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
  /* every photo of a product, cover first */
  function photosOf(it) {
    if (it.photos && it.photos.length) return it.photos;
    return it.photo ? [it.photo] : [];
  }
  /* absolute address, because a url() inside a CSS variable is resolved from the stylesheet's folder */
  function cssUrl(path) {
    var abs = String(path);
    try { abs = new URL(abs, document.baseURI).href; } catch (e) { /* keep the relative path */ }
    return "url('" + abs.replace(/['()\\]/g, '') + "')";
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

  function setChrome(theme, backHref, markRest, title, subtitle) {
    document.body.dataset.theme = theme;
    if (themeMeta) themeMeta.content = THEME_COLOR[theme] || '#ffffff';
    back.hidden = !backHref;
    if (backHref) back.href = backHref;
    mark.hidden = !markRest;
    if (markRest) {
      mark.href = '#/' + encodeURIComponent(markRest.id);
      mark.innerHTML = '<span class="bar-logo"><img src="' + esc(markRest.logo) + '" alt="' + esc(tx(markRest.name)) + '"></span>' +
        '<span class="bar-title"><b>' + esc(tx(markRest.name)) + '</b><span>' + esc(subtitle || '') + '</span></span>';
    }
    document.title = title;
  }

  var WAVE = '<svg class="door-wave" viewBox="0 0 400 22" preserveAspectRatio="none" aria-hidden="true"><path d="M0 0h400v8c-34 16-66 16-100 4s-66-12-100 0-66 12-100 0S34-4 0 8z"/></svg>';

  function drawHome() {
    var hotel = data.hotel || {};
    setChrome('hotel', '', null, tx(hotel.name));
    var above = '#ffffff';
    var doors = (data.restaurants || []).map(function (r) {
      var colour = DOOR_COLOR[r.theme] || '#f1f4f6';
      var style = ' style="--door:' + colour + ';--above:' + above + '"';
      above = colour;
      if (r.soon) {
        return '<div class="door door--soon"' + style + '>' + WAVE +
          '<p class="soon"><span>' + t('newRestaurant') + '</span><strong>' + t('comingSoon') + '</strong></p></div>';
      }
      var label = tx(r.name) + (tx(r.tagline) ? ', ' + tx(r.tagline) : '');
      return '<a class="door door--' + esc(r.theme) + '" href="#/' + encodeURIComponent(r.id) + '"' + style + '>' + WAVE +
        '<img src="' + esc(r.logo) + '" alt="' + esc(label) + '"></a>';
    }).join('');
    return '<section class="home">' +
      '<div class="home-top"><h1 style="margin:0"><img class="home-logo" src="' + esc(hotel.logo) + '" alt="' + esc(tx(hotel.name)) + ', ' + esc(tx(hotel.place)) + '"></h1>' +
      '<p class="home-lead">' + t('lead') + '</p></div>' +
      '<nav class="doors" aria-label="' + t('restaurants') + '">' + doors + '</nav></section>';
  }

  /* the first photo found in a list of products, used for tiles and banners */
  function firstPhoto(items) {
    for (var i = 0; i < items.length; i++) { var p = photosOf(items[i]); if (p.length) return p[0]; }
    return '';
  }
  function bgStyle(photo) { return photo ? ' style="--img:' + esc(cssUrl(photo)) + '"' : ''; }

  function drawRestaurant(r) {
    setChrome(r.theme, '#/', null, tx(r.name) + ' · ' + tx(data.hotel.name));
    var label = tx(r.name) + (tx(r.tagline) ? ', ' + tx(r.tagline) : '');
    var rich = RICH[r.theme];
    var secs = (r.sections || []).map(function (s) {
      var photo = rich ? firstPhoto(s.items || []) : '';
      return '<a class="sec' + (photo ? ' has-img' : '') + '" href="#/' + encodeURIComponent(r.id) + '/' + encodeURIComponent(s.id) + '"' + bgStyle(photo) + '>' +
        '<span class="sec-name">' + esc(tx(s.name)) + '</span><span class="chev" aria-hidden="true"></span></a>';
    }).join('');
    if (!secs) secs = emptyHtml();
    return '<section class="rest"><h1 style="margin:0"><img class="rest-logo" src="' + esc(r.logo) + '" alt="' + esc(label) + '"></h1>' +
      '<nav class="secs">' + secs + '</nav></section>';
  }

  function emptyHtml() {
    return '<div class="empty"><strong>' + t('soon') + '</strong>' + t('soonText') + '</div>';
  }

  function searchKey(it) {
    var s = [(it.title || {}).en, (it.title || {}).ar, (it.desc || {}).en, (it.desc || {}).ar].join(' ');
    return esc(s.toLowerCase());
  }

  function itemHtml(it, rich) {
    var name = tx(it.title);
    var desc = tx(it.desc);
    var off = it.available === false;
    var photos = photosOf(it);
    var photo = photos.length
      ? '<button class="item-ph" type="button" data-zoom="' + esc(it.id) + '" aria-label="' + esc(t('photo') + name) + '"><img src="' + esc(photos[0]) + '" alt="" loading="lazy" decoding="async"></button>'
      : '';
    return '<article class="item' + (off ? ' item-off' : '') + (photo ? ' has-ph' : '') + '" data-q="' + searchKey(it) + '"' + (rich ? ' data-open="' + esc(it.id) + '"' : '') + '>' + photo +
      '<div class="item-body"><div class="item-row"><h3 class="item-name">' + esc(name) + '</h3><span class="item-lead" aria-hidden="true"></span>' +
      '<p class="price">' + priceHtml(it.price) + '</p></div>' +
      (desc ? '<p class="item-desc">' + esc(desc) + '</p>' : '') +
      (off ? '<span class="item-flag">' + t('off') + '</span>' : '') +
      '</div></article>';
  }

  /* a main plate: shown large at the top of its section, with all its photos */
  function featureHtml(it) {
    var name = tx(it.title);
    var desc = tx(it.desc);
    var off = it.available === false;
    var photos = photosOf(it);
    var gal = '';
    if (photos.length) {
      gal = '<div class="gal" tabindex="0">' + photos.map(function (p, i) {
        return '<button class="gal-ph" type="button" data-zoom="' + esc(it.id) + '" data-i="' + i + '" aria-label="' + esc(t('photo') + name) + ' ' + (i + 1) + '"><img src="' + esc(p) + '" alt=""' + (i ? ' loading="lazy"' : '') + ' decoding="async"></button>';
      }).join('') + '</div>';
      if (photos.length > 1) {
        gal += '<div class="gal-dots" aria-hidden="true">' + photos.map(function (p, i) { return '<i' + (i ? '' : ' class="on"') + '></i>'; }).join('') + '</div>';
      }
    }
    return '<article class="feature' + (off ? ' item-off' : '') + '" data-q="' + searchKey(it) + '">' + gal +
      '<div class="feature-tx"><div class="feature-row"><h2 class="feature-name">' + esc(name) + '</h2><p class="price">' + priceHtml(it.price) + '</p></div>' +
      (desc ? '<p class="feature-desc">' + esc(desc) + '</p>' : '') +
      (off ? '<span class="item-flag">' + t('off') + '</span>' : '') + '</div></article>';
  }

  function drawSection(r, s) {
    setChrome(r.theme, '#/' + encodeURIComponent(r.id), r, tx(s.name) + ' · ' + tx(r.name), tx(s.name));
    var rich = RICH[r.theme];
    var all = s.items || [];
    var mains = all.filter(function (it) { return it.main; });
    var items = all.filter(function (it) { return !it.main; });
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
          var photo = rich ? firstPhoto(b.items) : '';
          return '<button class="chip' + (photo ? ' has-img' : '') + '" type="button" data-jump="g-' + esc(b.id) + '"' + bgStyle(photo) + '><span>' + esc(b.name) + '</span></button>';
        }).join('') + '</nav>'
      : '';
    var search = rich && all.length > 6
      ? '<div class="search"><input id="q" type="search" placeholder="' + t('search') + '" aria-label="' + t('search') + '" autocomplete="off"></div>'
      : '';
    var feature = mains.length ? '<div class="features">' + mains.map(featureHtml).join('') + '</div>' : '';
    var body = blocks.map(function (b) {
      var photo = rich ? firstPhoto(b.items) : '';
      return '<section class="group" id="g-' + esc(b.id) + '">' +
        (b.name ? '<h2 class="group-title' + (photo ? ' has-img' : '') + '"' + bgStyle(photo) + '><span>' + esc(b.name) + '</span></h2>' : '') +
        '<div class="items">' + b.items.map(function (it) { return itemHtml(it, rich); }).join('') + '</div></section>';
    }).join('');
    if (!blocks.length && !mains.length) body = emptyHtml();
    return '<section class="menu"><header class="menu-head"><h1>' + esc(tx(s.name)) + '</h1></header>' +
      chips + search + feature + body +
      '<p class="noresults" id="noresults" hidden>' + t('noResults') + '</p>' +
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
    }, { rootMargin: '-45% 0px -50% 0px' });
    view.querySelectorAll('.group').forEach(function (g) { observer.observe(g); });
  }

  function draw(keepScroll) {
    if (!data) return;
    var r = route();
    var html;
    var rest = r.rid ? find(data.restaurants, r.rid) : null;
    if (rest && rest.soon) rest = null;
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

  function currentItem(id) {
    var r = route();
    var rest = find(data.restaurants, r.rid);
    var sec = rest && find(rest.sections, r.sid);
    return sec && find(sec.items, id);
  }
  function openZoom(it, index) {
    var photos = photosOf(it);
    var img = document.getElementById('zoomImg');
    var src = photos[index || 0] || '';
    img.hidden = !src;
    if (src) { img.src = src; img.alt = tx(it.title); } else img.removeAttribute('src');
    document.getElementById('zoomTitle').textContent = tx(it.title);
    document.getElementById('zoomDesc').textContent = tx(it.desc);
    document.getElementById('zoomDesc').hidden = !tx(it.desc);
    document.getElementById('zoomPrice').innerHTML = priceHtml(it.price);
    if (zoom.showModal) zoom.showModal(); else zoom.setAttribute('open', '');
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
    var it;
    if (z) {
      it = currentItem(z.dataset.zoom);
      if (it) openZoom(it, Number(z.dataset.i) || 0);
      return;
    }
    var card = e.target.closest('[data-open]');
    if (card) {
      it = currentItem(card.dataset.open);
      if (it) openZoom(it, 0);
    }
  });

  /* search inside a section */
  view.addEventListener('input', function (e) {
    if (e.target.id !== 'q') return;
    var q = e.target.value.trim().toLowerCase();
    var shown = 0;
    view.querySelectorAll('.item, .feature').forEach(function (el) {
      var hit = !q || (el.dataset.q || '').indexOf(q) !== -1;
      el.hidden = !hit;
      if (hit) shown++;
    });
    view.querySelectorAll('.group').forEach(function (g) { g.hidden = !g.querySelector('.item:not([hidden])'); });
    var chips = view.querySelector('.chips');
    if (chips) chips.hidden = !!q;
    document.getElementById('noresults').hidden = shown > 0;
  });

  /* photo strip of a main plate: light the dot of the photo in view */
  view.addEventListener('scroll', function (e) {
    var gal = e.target;
    if (!gal.classList || !gal.classList.contains('gal')) return;
    var dots = gal.parentNode.querySelectorAll('.gal-dots i');
    var i = Math.round(Math.abs(gal.scrollLeft) / gal.clientWidth);
    for (var k = 0; k < dots.length; k++) dots[k].className = k === i ? 'on' : '';
  }, true);

  /* a photo that has not been published yet (or was removed) simply does not show */
  view.addEventListener('error', function (e) {
    if (e.target.tagName !== 'IMG') return;
    var ph = e.target.closest('.item-ph, .gal-ph');
    if (!ph) return;
    var item = ph.closest('.item');
    var gal = ph.closest('.gal');
    ph.remove();
    if (item) item.classList.remove('has-ph');
    if (gal) {
      var dots = gal.parentNode.querySelector('.gal-dots');
      if (dots && dots.lastChild) dots.removeChild(dots.lastChild);
      if (!gal.children.length) { gal.remove(); if (dots) dots.remove(); }
    }
  }, true);
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
