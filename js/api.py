/* DamarzDev REST client - no Firebase dependency. */
const API_BASE = window.API_BASE || (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  ? 'http://127.0.0.1:5000' : 'https://api.domain.my.id');

const ServerValue = {
  serverTimestamp: () => ({__op: 'serverTimestamp'}),
  increment: (value) => ({__op: 'increment', value: Number(value) || 0})
};

function authHeaders() {
  const token = localStorage.getItem('license_api_token');
  return token ? {'Authorization': 'Bearer ' + token} : {};
}

async function apiFetch(path, options = {}) {
  const headers = {'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {})};
  const res = await fetch(API_BASE + path, {...options, headers});
  let body = {};
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) {
    const e = new Error(body.error || body.message || `HTTP ${res.status}`);
    e.code = body.code || `http-${res.status}`;
    throw e;
  }
  return body;
}

function wrapDoc(item, collectionName) {
  const data = item?.data || item || {};
  const id = item?.id ?? data.id;
  const normalized = normalize(data);
  return {
    id,
    ref: makeDocRef(collectionName, id),
    exists: true,
    data: () => normalized
  };
}

function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (!v || typeof v !== 'object') return v;
  if (v.__timestamp) {
    const d = new Date(v.__timestamp);
    return {toDate: () => d, toMillis: () => d.getTime(), valueOf: () => d.getTime(), toJSON: () => d.toISOString()};
  }
  const o = {};
  for (const [k, val] of Object.entries(v)) o[k] = normalize(val);
  return o;
}

function makeDocRef(collectionName, id) {
  return {
    id,
    async get() {
      const r = await apiFetch(`/api/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(id)}`);
      return wrapDoc(r, collectionName);
    },
    async set(data, options = {}) {
      return apiFetch(`/api/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(id)}`, {method:'PUT', body:JSON.stringify({data, merge:!!options.merge})});
    },
    async update(data) {
      return apiFetch(`/api/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(id)}`, {method:'PATCH', body:JSON.stringify({data})});
    },
    async delete() {
      return apiFetch(`/api/collections/${encodeURIComponent(collectionName)}/${encodeURIComponent(id)}`, {method:'DELETE'});
    }
  };
}

function makeQuery(collectionName, filters = [], order = null, max = null) {
  const q = {
    where(field, op, value) { return makeQuery(collectionName, [...filters, {field, op, value}], order, max); },
    orderBy(field, direction='asc') { return makeQuery(collectionName, filters, {field, direction}, max); },
    limit(n) { return makeQuery(collectionName, filters, order, n); },
    async get() {
      const params = new URLSearchParams();
      if (filters.length) params.set('where', JSON.stringify(filters));
      if (order) params.set('orderBy', order.field); params.set('orderDir', order?.direction || 'asc');
      if (max) params.set('limit', String(max));
      const r = await apiFetch(`/api/collections/${encodeURIComponent(collectionName)}?${params}`);
      const docs = (r.items || []).map(x => wrapDoc(x, collectionName));
      return {docs, empty: docs.length === 0, size: docs.length, forEach(fn){docs.forEach(fn)}};
    },
    onSnapshot(callback, errorCallback) {
      let stopped = false, last = '';
      const tick = async () => {
        if (stopped) return;
        try {
          const snap = await this.get();
          const sig = JSON.stringify(snap.docs.map(d => [d.id, d.data()]));
          if (sig !== last) { last = sig; callback(snap); }
        } catch (e) { if (errorCallback) errorCallback(e); }
        if (!stopped) setTimeout(tick, 3000);
      };
      tick();
      return () => { stopped = true; };
    }
  };
  return q;
}

const db = {
  collection(name) {
    return {
      ...makeQuery(name),
      doc(id) { return makeDocRef(name, id); },
      async add(data) {
        return apiFetch(`/api/collections/${encodeURIComponent(name)}`, {method:'POST', body:JSON.stringify({data})});
      }
    };
  },
  batch() {
    const ops = [];
    return {
      update(ref, data) { ops.push({method:'PATCH', path:`/api/collections/${ref.collectionName || ''}/${ref.id}`, data}); },
      async commit() { return apiFetch('/api/batch', {method:'POST', body:JSON.stringify({ops})}); }
    };
  }
};

// Patch refs created above so batch() can identify their collection.
const _collection = db.collection.bind(db);
db.collection = function(name) {
  const c = _collection(name);
  const oldDoc = c.doc;
  c.doc = function(id) {
    const r = oldDoc(id); r.collectionName = name; return r;
  };
  return c;
};

const auth = {
  _listeners: [],
  get currentUser() {
    const raw = localStorage.getItem('license_api_user');
    return raw ? JSON.parse(raw) : null;
  },
  async signInWithEmailAndPassword(email, password) {
    const r = await apiFetch('/api/auth/login', {method:'POST', body:JSON.stringify({email, password})});
    localStorage.setItem('license_api_token', r.token);
    localStorage.setItem('license_api_user', JSON.stringify(r.user));
    this._listeners.forEach(fn => fn(r.user));
    return {user:r.user};
  },
  async createUserWithEmailAndPassword(email, password) {
    const r = await apiFetch('/api/auth/create', {method:'POST', body:JSON.stringify({email, password})});
    return {user:r.user};
  },
  async signOut() {
    localStorage.removeItem('license_api_token');
    localStorage.removeItem('license_api_user');
    this._listeners.forEach(fn => fn(null));
  },
  onAuthStateChanged(fn) {
    this._listeners.push(fn);
    setTimeout(() => fn(this.currentUser), 0);
    return () => { this._listeners = this._listeners.filter(x => x !== fn); };
  }
};

// Compatibility only for the old secondary-account creation flow in auth.js.
const apiSecondaryApp = {name:'Secondary', auth:() => auth};
function createSecondaryApp() { return apiSecondaryApp; }
