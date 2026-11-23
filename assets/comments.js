(function () {
  'use strict';
  var section = document.getElementById('garden-comments');
  if (!section) return;
  var root = section.querySelector('.gc-root') || section;

  var KEY = 'garden_token';
  var MAX = 2000;
  var thread = section.getAttribute('data-thread') || '';
  var api = section.getAttribute('data-api') || '';

  // 本地测试：?api=http://localhost:8787
  try {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
      var q = new URLSearchParams(location.search).get('api');
      if (q) {
        var qu = new URL(q);
        if (qu.protocol === 'http:' && (qu.hostname === 'localhost' || qu.hostname === '127.0.0.1')) api = q;
      }
    }
  } catch (e) {}
  api = api.replace(/\/+$/, '');

  // ---------- 令牌 ----------
  function getToken() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { localStorage.setItem(KEY, t); } catch (e) {} }
  function clearToken() { try { localStorage.removeItem(KEY); } catch (e) {} }

  var authNote = '';
  try {
    var h = location.hash || '';
    if (h.indexOf('garden_token=') !== -1) {
      var t = new URLSearchParams(h.replace(/^#/, '')).get('garden_token');
      if (t) setToken(t);
      history.replaceState(null, '', location.pathname + location.search);
    } else if (h.indexOf('garden_error=') !== -1) {
      var ge = new URLSearchParams(h.replace(/^#/, '')).get('garden_error');
      if (ge === 'cancelled') authNote = '登录取消了。';
      else if (ge === 'failed') authNote = '登录没成功，再试一次？';
      history.replaceState(null, '', location.pathname + location.search);
    }
  } catch (e) {}

  // ---------- 状态 ----------
  var token = getToken();
  var me = null;          // {login,name,avatar,is_admin}
  var viewer = null;
  var comments = [];

  // ---------- 小工具 ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function btn(label, cls, onclick) {
    var b = el('button', cls, label);
    b.type = 'button';
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }

  function request(method, path, body) {
    var headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var opt = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    return fetch(api + path, opt).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
        if (res.status === 401 && token) { logout(true); }
        if (!res.ok) {
          var err = new Error((data && data.error) || (res.status === 429 ? '发得太频繁了，稍等一下。' : '出了点问题，请稍后再试。'));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function logout(silent) {
    clearToken();
    token = '';
    me = null;
    viewer = null;
    renderAll();
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function relTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function fullTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // 纯文本 + 自动链接；只用 textContent / createTextNode，不拼 HTML
  function renderBody(text) {
    var box = el('div', 'gc-body');
    var re = /https?:\/\/[^\s<>"']+/g;
    var last = 0, m;
    while ((m = re.exec(text)) !== null) {
      var url = m[0], tail = '';
      var mt = url.match(/[.,;:!?)\]}，。；：！？、）】》]+$/);
      if (mt) { tail = mt[0]; url = url.slice(0, url.length - tail.length); }
      if (m.index > last) box.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (url) {
        var a = el('a', null, url);
        a.href = url;
        a.rel = 'nofollow noopener';
        a.target = '_blank';
        box.appendChild(a);
      }
      if (tail) box.appendChild(document.createTextNode(tail));
      last = m.index + m[0].length;
    }
    if (last < text.length) box.appendChild(document.createTextNode(text.slice(last)));
    return box;
  }

  function avatar(login, src) {
    var a = el('a');
    a.href = 'https://github.com/' + encodeURIComponent(login);
    a.rel = 'noopener';
    a.target = '_blank';
    var img = el('img', 'gc-avatar');
    img.alt = '';
    img.loading = 'lazy';
    img.src = src || '';
    a.appendChild(img);
    return a;
  }

  // ---------- 骨架 ----------
  var authBox = el('div', 'gc-auth');
  var formBox = el('div', 'gc-formbox');
  var listBox = el('div', 'gc-list');
  var statusBox = el('p', 'gc-status', '正在加载……');
  root.appendChild(authBox);
  root.appendChild(formBox);
  root.appendChild(statusBox);
  root.appendChild(listBox);

  function loginUrl() {
    var back = location.href.replace(/#.*$/, '');
    return api + '/auth/login?return=' + encodeURIComponent(back);
  }

  function renderAuth() {
    authBox.textContent = '';
    if (token && (me || viewer)) {
      var u = me || { login: viewer.login, name: viewer.login, avatar: '' };
      var box = el('span', 'gc-me');
      box.appendChild(avatar(u.login, u.avatar));
      box.appendChild(el('span', 'gc-name', u.name || u.login));
      authBox.appendChild(box);
      authBox.appendChild(btn('退出', 'gc-link', function () { logout(false); }));
    }
  }

  function renderComposer() {
    formBox.textContent = '';
    if (token) {
      formBox.appendChild(buildForm(null, function (item) {
        comments.push(item);
        renderList();
      }));
    } else {
      var b = btn('用 GitHub 登录后留言', 'gc-btn gc-btn-ghost', function () { location.href = loginUrl(); });
      var wrap = el('div', 'gc-form');
      wrap.appendChild(b);
      if (authNote) wrap.appendChild(el('small', 'gc-note', authNote));
      formBox.appendChild(wrap);
    }
  }

  function renderAll() {
    renderAuth();
    renderComposer();
    renderList();
  }

  // ---------- 输入框 ----------
  function buildForm(parentId, onDone, onCancel) {
    var form = el('form', 'gc-form' + (parentId ? ' gc-reply-form' : ''));
    var ta = el('textarea');
    ta.placeholder = parentId ? '回复……' : '想说点什么？';
    ta.rows = parentId ? 2 : 3;
    ta.maxLength = MAX + 200; // 留点余量，让超限提示可见
    var row = el('div', 'gc-form-row');
    var err = el('span', 'gc-err');
    var count = el('span', 'gc-count');
    var submit = el('button', 'gc-btn', '留下');
    submit.type = 'submit';
    row.appendChild(err);
    row.appendChild(count);
    if (onCancel) row.appendChild(btn('取消', 'gc-link', onCancel));
    row.appendChild(submit);
    form.appendChild(ta);
    form.appendChild(row);

    function grow() {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight + 2, 360) + 'px';
    }
    function upd() {
      var n = ta.value.length;
      if (n >= MAX - 200) {
        count.textContent = n + ' / ' + MAX;
        count.className = 'gc-count' + (n > MAX ? ' over' : '');
      } else {
        count.textContent = '';
      }
      grow();
    }
    ta.addEventListener('input', upd);

    function send() {
      var body = ta.value.trim();
      err.textContent = '';
      if (body.length < 1) { err.textContent = '写点什么再留下吧。'; return; }
      if (body.length > MAX) { err.textContent = '太长了，最多 ' + MAX + ' 字。'; return; }
      submit.disabled = true;
      ta.disabled = true;
      var payload = { thread: thread, body: body };
      if (parentId) payload.parent_id = parentId;
      request('POST', '/api/comments', payload).then(function (item) {
        ta.value = '';
        upd();
        submit.disabled = false;
        ta.disabled = false;
        onDone(item);
      }, function (e) {
        submit.disabled = false;
        ta.disabled = false;
        err.textContent = e.message || '发送失败。';
      });
    }
    form.addEventListener('submit', function (ev) { ev.preventDefault(); if (!submit.disabled) send(); });
    ta.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); if (!submit.disabled) send(); }
    });
    return form;
  }

  // ---------- 列表 ----------
  function byTime(a, b) { return new Date(a.created_at) - new Date(b.created_at); }

  function renderList() {
    listBox.textContent = '';
    var isAdmin = !!(viewer && viewer.is_admin) || !!(me && me.is_admin);
    var byId = {};
    comments.forEach(function (c) { byId[c.id] = c; });
    function rootOf(c) {
      var seen = 0;
      while (c.parent_id && byId[c.parent_id] && seen++ < 20) c = byId[c.parent_id];
      return c;
    }
    var tops = [], kids = {};
    comments.slice().sort(byTime).forEach(function (c) {
      if (!c.parent_id) { tops.push(c); return; }
      var r = rootOf(c);
      if (r === c || r.parent_id) return; // 找不到根：忽略
      (kids[r.id] = kids[r.id] || []).push(c);
    });
    tops.reverse();

    if (!tops.length) {
      statusBox.textContent = statusBox.getAttribute('data-state') === 'ready' ? '还没有人说话，你来当第一个？' : statusBox.textContent;
      return;
    }
    statusBox.textContent = '';
    tops.forEach(function (c) {
      var item = el('div', 'gc-item');
      item.appendChild(buildEntry(c, true, isAdmin, (kids[c.id] || []).length > 0, item));
      var rs = kids[c.id] || [];
      if (rs.length) {
        var wrap = el('div', 'gc-replies');
        rs.forEach(function (r) {
          var box = el('div', 'gc-reply');
          box.appendChild(buildEntry(r, false, isAdmin, false, box));
          wrap.appendChild(box);
        });
        item.appendChild(wrap);
      }
      listBox.appendChild(item);
    });
  }

  function buildEntry(c, top, isAdmin, hasReplies, host) {
    var entry = el('div', 'gc-entry' + (c.hidden ? ' gc-hidden' : ''));
    var head = el('div', 'gc-head');
    head.appendChild(avatar(c.login, c.avatar));
    var name = el('a', 'gc-name', c.name || c.login);
    name.href = 'https://github.com/' + encodeURIComponent(c.login);
    name.rel = 'noopener';
    name.target = '_blank';
    head.appendChild(name);
    if (c.is_admin) {
      var st = el('span', 'gc-star', '✦');
      st.title = '站主';
      head.appendChild(st);
    }
    var tm = el('time', 'gc-time', relTime(c.created_at));
    tm.title = fullTime(c.created_at);
    tm.setAttribute('datetime', c.created_at);
    head.appendChild(tm);
    if (c.hidden) head.appendChild(el('span', 'gc-tag', '已隐藏'));
    entry.appendChild(head);
    entry.appendChild(renderBody(c.body || ''));

    var acts = el('div', 'gc-actions');
    if (token && top) {
      acts.appendChild(btn('回复', 'gc-link', function () { openReply(c, host, entry); }));
    }
    if (token && c.mine) {
      acts.appendChild(btn('撤回', 'gc-link', function () {
        var msg = top && hasReplies ? '撤回这条留言？它下面的回复也会一起撤掉。' : '撤回这条留言？';
        if (confirm(msg)) removeComment(c);
      }));
    }
    if (token && isAdmin) {
      acts.appendChild(btn(c.hidden ? '取消隐藏' : '隐藏', 'gc-link', function () {
        request('POST', '/api/comments/' + encodeURIComponent(c.id) + '/hide', { hidden: !c.hidden }).then(function (u) {
          for (var i = 0; i < comments.length; i++) {
            if (comments[i].id === c.id) { comments[i] = u && u.id ? u : Object.assign({}, comments[i], { hidden: !c.hidden }); break; }
          }
          renderList();
        }, function (e) { alert(e.message); });
      }));
      if (!c.mine) {
        acts.appendChild(btn('删除', 'gc-link', function () {
          if (confirm('删除这条留言？' + (top && hasReplies ? '它下面的回复也会一起删掉。' : ''))) removeComment(c);
        }));
      }
    }
    if (acts.childNodes.length) entry.appendChild(acts);
    return entry;
  }

  function removeComment(c) {
    request('DELETE', '/api/comments/' + encodeURIComponent(c.id)).then(function (r) {
      var gone = {};
      ((r && r.deleted) || [c.id]).forEach(function (id) { gone[id] = true; });
      comments = comments.filter(function (x) { return !gone[x.id]; });
      renderList();
    }, function (e) { alert(e.message); });
  }

  function openReply(c, host, entry) {
    var old = host.querySelector(':scope > .gc-reply-form');
    if (old) { old.querySelector('textarea').focus(); return; }
    var form = buildForm(c.id, function (item) {
      comments.push(item);
      renderList();
    }, function () { form.remove(); });
    // 放在该条留言正文之后、回复列表之前
    entry.parentNode.insertBefore(form, entry.nextSibling);
    form.querySelector('textarea').focus();
  }

  // ---------- 启动 ----------
  function load() {
    statusBox.setAttribute('data-state', 'loading');
    statusBox.textContent = '正在加载……';
    renderAuth();
    renderComposer();
    var p = request('GET', '/api/comments?thread=' + encodeURIComponent(thread));
    if (token) {
      request('GET', '/api/me').then(function (m) { me = m; renderAuth(); renderList(); }, function () {});
    }
    p.then(function (d) {
      comments = (d && d.comments) || [];
      viewer = (d && d.viewer) || null;
      if (token && !viewer && !me) {
        // 令牌无效但后端未报 401：稍后由 /api/me 兜底
      }
      statusBox.setAttribute('data-state', 'ready');
      renderAuth();
      renderList();
    }, function (e) {
      if (e && e.status === 401) { load(); return; } // 令牌已清，以游客身份重载
      statusBox.setAttribute('data-state', 'error');
      statusBox.textContent = '留言暂时加载不出来，过会儿再来看看。';
    });
  }

  load();
})();
