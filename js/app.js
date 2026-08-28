// ===== VERSION: 2026-08-27-v9-ROLES =====
let dbData = {
    keys: [],
    resellers: [],
    admins: [],
    activities: [],
    stats: { active_keys: 0, total_keys: 0, credit: 1000 }
};

let lastGeneratedKey = '';

// ============================================
// ROLE GUARDS
// ============================================
function isOwner() {
    if (userData && typeof userData.role === 'string') return userData.role === 'owner';
    return userRole === 'owner';
}
function isAdmin() {
    if (userData && typeof userData.role === 'string') return userData.role === 'admin';
    return userRole === 'admin';
}
function isReseller() {
    if (userData && typeof userData.role === 'string') return userData.role === 'reseller';
    return userRole === 'reseller';
}

// ============================================
// CREDIT (owner-only pool credit, or reseller credit)
// Supports the literal 'unlimited' sentinel. Never coerce it to a number.
// ============================================
function getMyCredit() {
    if (isOwner()) {
        return isUnlimitedCredit(dbData.stats.credit) ? 'unlimited' : (Number(dbData.stats.credit) || 0);
    }
    if (isReseller()) {
        if (!currentUser) return 0;
        const myReseller =
            dbData.resellers.find(r => r.userId === currentUser.uid) ||
            dbData.resellers.find(r => r.id === currentUser.uid);
        if (!myReseller) return 0;
        return isUnlimitedCredit(myReseller.credit) ? 'unlimited' : (Number(myReseller.credit) || 0);
    }
    if (isAdmin()) {
        // Admin's own credit doc is merged into userData at login (see auth.js
        // validateSession) — Owner can now grant credit to an Admin directly,
        // which the Admin can in turn hand out to resellers in their own tree.
        if (!userData) return 0;
        return isUnlimitedCredit(userData.credit) ? 'unlimited' : (Number(userData.credit) || 0);
    }
    return null;
}

// ============================================
// OWNERSHIP HELPERS
// ============================================
// Every key stores: createdBy (uid), createdByRole, createdByUsername, parentAdminId.
// Legacy keys without these fields fall back to Owner-only visibility (safe default).
function keyBelongsToMe(k) {
    if (!currentUser) return false;
    if (isOwner()) return true;
    if (isAdmin()) {
        return k.createdBy === currentUser.uid || k.parentAdminId === currentUser.uid;
    }
    if (isReseller()) {
        if (k.createdBy) return k.createdBy === currentUser.uid;
        // Legacy fallback by username tag, for very old records only.
        const myUsername = userData?.username || 'unknown';
        const legacyOwner = k.createdByUsername || k.tag?.match(/\(([^)]+)\)/)?.[1] || null;
        return legacyOwner === myUsername;
    }
    return false;
}

function isKeyOwner(keyData) {
    if (!keyData) return false;
    if (isOwner()) return true;
    if (isAdmin()) return keyData.createdBy === currentUser?.uid || keyData.parentAdminId === currentUser?.uid;
    if (isReseller()) return keyData.createdBy === currentUser?.uid;
    return false;
}

// "All" scope = everything visible to my role (Owner: all system; Admin: self + my resellers; Reseller: only self)
function getMyKeys() {
    if (isOwner()) return dbData.keys;
    return dbData.keys.filter(keyBelongsToMe);
}

// "Private/Pribadi" scope = only keys created by ME personally (never subordinates)
function getPrivateKeys() {
    if (!currentUser) return [];
    return dbData.keys.filter(k => k.createdBy ? k.createdBy === currentUser.uid :
        (k.createdByUsername || k.tag?.match(/\(([^)]+)\)/)?.[1]) === (userData?.username || 'unknown'));
}

// ============================================
// REAL-TIME LISTENERS
// ============================================
function startListeners() {
    if (window.keyUnsubs) window.keyUnsubs.forEach(fn => { try { fn(); } catch (_) {} });
    window.keyUnsubs = [];

    const renderAll = () => { updateStatsUI(); renderKeys(); renderMyKeys(); };

    // ---------- KEYS ----------
    if (isOwner()) {
        const unsub = db.collection('keys').orderBy('createdAt', 'desc')
            .onSnapshot((snapshot) => {
                dbData.keys = [];
                snapshot.forEach(doc => dbData.keys.push({ id: doc.id, ...doc.data() }));
                renderAll();
            }, (error) => console.error('Keys listener error:', error));
        window.keyUnsubs.push(unsub);

    } else if (isAdmin() && currentUser) {
        const own = new Map();
        const underTree = new Map();
        const merge = () => {
            const merged = new Map([...own, ...underTree]);
            dbData.keys = Array.from(merged.values()).sort((a, b) => {
                const t = (x) => x.createdAt?.toMillis ? x.createdAt.toMillis() : 0;
                return t(b) - t(a);
            });
            renderAll();
        };
        window.keyUnsubs.push(db.collection('keys').where('createdBy', '==', currentUser.uid)
            .onSnapshot(s => { own.clear(); s.forEach(d => own.set(d.id, { id: d.id, ...d.data() })); merge(); },
                e => console.error('Admin own keys error:', e)));
        window.keyUnsubs.push(db.collection('keys').where('parentAdminId', '==', currentUser.uid)
            .onSnapshot(s => { underTree.clear(); s.forEach(d => underTree.set(d.id, { id: d.id, ...d.data() })); merge(); },
                e => console.error('Admin tree keys error:', e)));

    } else if (isReseller() && currentUser) {
        const byUid = new Map();
        const byUsername = new Map();
        const username = userData?.username;
        const renderResellerKeys = () => {
            const merged = new Map([...byUid, ...byUsername]);
            dbData.keys = Array.from(merged.values()).sort((a, b) => {
                const t = (x) => x.createdAt?.toMillis ? x.createdAt.toMillis() : 0;
                return t(b) - t(a);
            });
            renderAll();
        };
        window.keyUnsubs.push(db.collection('keys').where('createdBy', '==', currentUser.uid)
            .onSnapshot(s => { byUid.clear(); s.forEach(d => byUid.set(d.id, { id: d.id, ...d.data() })); renderResellerKeys(); },
                e => console.error('Own key listener error:', e)));
        if (username) {
            window.keyUnsubs.push(db.collection('keys').where('createdByUsername', '==', username)
                .onSnapshot(s => { byUsername.clear(); s.forEach(d => byUsername.set(d.id, { id: d.id, ...d.data() })); renderResellerKeys(); },
                    e => console.error('Legacy key listener error:', e)));
        }
    }

    // ---------- RESELLERS ----------
    if (isOwner()) {
        window.keyUnsubs.push(db.collection('resellers').orderBy('username')
            .onSnapshot(s => {
                dbData.resellers = [];
                s.forEach(d => dbData.resellers.push({ id: d.id, ...d.data() }));
                loadResellers(); updateRanking(); updateStatsUI();
            }, e => console.error('Resellers listener error:', e)));
    } else if (isAdmin() && currentUser) {
        window.keyUnsubs.push(db.collection('resellers').where('parentAdminId', '==', currentUser.uid)
            .onSnapshot(s => {
                dbData.resellers = [];
                s.forEach(d => dbData.resellers.push({ id: d.id, ...d.data() }));
                loadResellers(); updateRanking(); updateStatsUI();
            }, e => console.error('Admin resellers listener error:', e)));
    } else if (isReseller() && currentUser) {
        window.keyUnsubs.push(db.collection('resellers').where('userId', '==', currentUser.uid).limit(1)
            .onSnapshot(s => {
                dbData.resellers = [];
                s.forEach(d => dbData.resellers.push({ id: d.id, ...d.data() }));
                updateStatsUI();
            }, e => console.error('My reseller listener error:', e)));
    }

    // ---------- ADMINS (Owner only) ----------
    if (isOwner()) {
        window.keyUnsubs.push(db.collection('admins').orderBy('username')
            .onSnapshot(s => {
                dbData.admins = [];
                s.forEach(d => dbData.admins.push({ id: d.id, ...d.data() }));
                loadAdmins();
            }, e => console.error('Admins listener error:', e)));
    }

    // ---------- ACTIVITIES ----------
    if (window.activityUnsubscribe) { window.activityUnsubscribe(); window.activityUnsubscribe = null; }
    if (isOwner()) {
        window.activityUnsubscribe = db.collection('activities').orderBy('timestamp', 'desc').limit(50)
            .onSnapshot(s => { dbData.activities = []; s.forEach(d => dbData.activities.push({ id: d.id, ...d.data() })); renderActivities(); },
                e => console.error('Activities listener error:', e));
    } else if (isAdmin() && currentUser) {
        window.activityUnsubscribe = db.collection('activities').where('parentAdminId', '==', currentUser.uid)
            .orderBy('timestamp', 'desc').limit(50)
            .onSnapshot(s => { dbData.activities = []; s.forEach(d => dbData.activities.push({ id: d.id, ...d.data() })); renderActivities(); },
                e => console.error('Admin activities listener error:', e));
    } else {
        dbData.activities = [];
        renderActivities();
    }

    // ---------- OWNER SYSTEM STATS ----------
    if (isOwner()) {
        if (window.statsUnsubscribe) { window.statsUnsubscribe(); window.statsUnsubscribe = null; }
        window.statsUnsubscribe = db.collection('system').doc('stats').onSnapshot((doc) => {
            if (doc.exists) { dbData.stats = doc.data(); updateStatsUI(); }
            else db.collection('system').doc('stats').set({ active_keys: 0, total_keys: 0, credit: 1000 });
        }, e => console.error('Stats listener error:', e));
    } else {
        dbData.stats = { ...dbData.stats, credit: 0 };
        updateStatsUI();
    }
}

// ============================================
// STATS UI
// ============================================
function updateStatsUI() {
    const allKeys = getMyKeys();
    const privateKeys = getPrivateKeys();

    const activeAll = allKeys.filter(k => k.status === 'active').length || 0;
    const awaitAll = allKeys.filter(k => k.status === 'paused' || k.status === 'ban').length || 0;
    const activePrivate = privateKeys.filter(k => k.status === 'active').length || 0;
    const awaitPrivate = privateKeys.filter(k => k.status === 'paused' || k.status === 'ban').length || 0;

    setText('activeAll', activeAll);
    setText('awaitAll', awaitAll);
    setText('activePrivate', activePrivate);
    setText('awaitPrivate', awaitPrivate);

    // Owner-only widgets (activity log, ranking panel, dev credit, create admin)
    document.querySelectorAll('.owner-only').forEach(el => { el.style.display = isOwner() ? 'block' : 'none'; });
    // Owner + Admin widgets (create reseller, manage resellers)
    document.querySelectorAll('.owner-admin-only').forEach(el => { el.style.display = (isOwner() || isAdmin()) ? 'block' : 'none'; });
    // Everyone except Admin (Admin has no personal credit / key-creation quota display)
    document.querySelectorAll('.no-admin').forEach(el => { el.style.display = isAdmin() ? 'none' : ''; });

    // CREDIT
    const myCredit = getMyCredit();
    const creditText = myCredit === null ? '—' : '💰 ' + formatCredit(myCredit);

    setText('headerCredit', creditText);
    setText('mobileCredit', creditText);
    setText('creditNum', myCredit === null ? '—' : formatCredit(myCredit));

    const creditInput = document.getElementById('creditInput');
    if (creditInput && myCredit !== null) creditInput.value = isUnlimitedCredit(myCredit) ? 'unlimited' : myCredit;
}

function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
}

function renderActivities() {
    const el = document.getElementById('activity');
    if (!el) return;
    if (!isOwner() && !isAdmin()) {
        el.innerHTML = '<div class="empty-state">🔒 Activity log tidak tersedia untuk role ini.</div>';
        return;
    }
    let acts = dbData.activities.slice(0, 10);
    if (!acts.length) {
        el.innerHTML = '<div class="empty-state">Belum ada aktivitas terbaru.</div>';
    } else {
        el.innerHTML = acts.map(a => `
            <div class="arow">
                <div><span class="label">Activity</span><span class="value">${esc(a.action)}${a.details ? ' · <small>' + esc(a.details) + '</small>' : ''}</span></div>
                <div><span class="label">Actor</span><span class="value">${esc(a.actor)}</span></div>
                <div><span class="label">Date</span><span class="value">${a.timestamp ? new Date(a.timestamp.toDate()).toLocaleString() : 'Just now'}</span></div>
            </div>
        `).join('');
    }
}

function updateRanking() {
    const el = document.getElementById('ranking');
    if (!el) return;
    if (!isOwner() && !isAdmin()) {
        el.innerHTML = '<div class="empty-state">🔒 Ranking hanya untuk Owner/Admin.</div>';
        return;
    }
    const sorted = [...dbData.resellers].sort((a, b) => (b.createdKeys || 0) - (a.createdKeys || 0));
    el.innerHTML = sorted.length ? sorted.slice(0, 5).map((r, i) => `
        <div class="rank-row">
            <div class="rank-no">#${i + 1}</div>
            <div class="rank-name"><b>${esc(r.username)}</b><small>${esc(r.status)}</small></div>
            <div class="rank-count">${r.createdKeys || 0} keys</div>
        </div>
    `).join('') : '<div class="empty-state">Belum ada data ranking.</div>';
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}

// ============================================
// DURATION UI
// ============================================
function durationUI() {
    const COST = { hours: 2, day: 5, week: 30, monthly: 100, yearly: 500, permanent: 1000 };
    const v = document.getElementById('duration').value;
    document.getElementById('cost').textContent = COST[v] + ' credits';
    document.getElementById('unit').textContent = v;
    document.getElementById('amountBox').style.display = v === 'permanent' ? 'none' : 'block';
}

function mode(v) {
    document.getElementById('randomBox').style.display = v === 'random' ? 'block' : 'none';
    document.getElementById('customBox').style.display = v === 'custom' ? 'block' : 'none';
    document.getElementById('rm').classList.toggle('sel', v === 'random');
    document.getElementById('cm').classList.toggle('sel', v === 'custom');
}

function copyResult() {
    if (lastGeneratedKey) navigator.clipboard.writeText(lastGeneratedKey);
}

// ============================================
// RESELLER ACCESS CHECK
// ============================================
async function getMyResellerDoc() {
    if (!currentUser) return null;
    const direct = await db.collection('resellers').doc(currentUser.uid).get();
    if (direct.exists) return direct;
    const query = await db.collection('resellers').where('userId', '==', currentUser.uid).limit(1).get();
    return query.empty ? null : query.docs[0];
}

async function verifyResellerAccess() {
    if (!currentUser) return false;
    if (isOwner() || isAdmin()) return true; // Admin creates keys under its own uid, no credit gate.

    const resellerDoc = await getMyResellerDoc();
    if (!resellerDoc || !resellerDoc.exists) {
        await auth.signOut();
        alert('🔒 Akun reseller sudah dihapus / dicabut.');
        return false;
    }
    const data = resellerDoc.data();
    if (data.userId && data.userId !== currentUser.uid) {
        await auth.signOut();
        alert('🔒 Account authorization mismatch.');
        return false;
    }
    if (data.status !== 'active') {
        await auth.signOut();
        alert('🔒 Akun reseller tidak aktif.');
        return false;
    }
    if (data.until && data.until !== 'PERMANENT') {
        const until = new Date(data.until);
        if (!Number.isNaN(until.getTime()) && until <= new Date()) {
            try { await db.collection('users').doc(currentUser.uid).set({ status: 'expired', updatedAt: ServerValue.serverTimestamp() }, { merge: true }); } catch (_) {}
            try { await resellerDoc.ref.update({ status: 'expired', updatedAt: ServerValue.serverTimestamp() }); } catch (_) {}
            await auth.signOut();
            alert('⏰ Masa aktif reseller sudah habis.');
            return false;
        }
    }
    return true;
}

// ============================================
// CREATE KEY  (unlimited-credit aware)
// ============================================
async function createKey() {
    if (!currentUser) return;
    if (!(await verifyResellerAccess())) return;

    const duration = document.getElementById('duration').value;
    const amount = parseInt(document.getElementById('amount').value) || 1;
    const maxDevices = parseInt(document.getElementById('max').value) || 1;
    const tag = document.getElementById('tag').value || 'New License';
    const prefix = document.getElementById('prefix').value || 'MARZZ';
    const customKey = document.getElementById('custom').value.trim();

    try {
        const r = await apiFetch('/api/license/create', {
            method: 'POST',
            body: JSON.stringify({duration, amount, maxDevices, tag, prefix, customKey})
        });
        lastGeneratedKey = r.key;
        document.getElementById('result').style.display = 'flex';
        document.getElementById('resultKey').textContent = r.key;
        alert('✅ Key dibuat! ' + r.key + (r.credit === 'unlimited' ? ' · ∞ Unlimited credit' : '\n💰 ' + r.cost + ' credits digunakan.'));
        refresh();
    } catch (error) {
        alert('❌ ' + (error.message || 'Gagal membuat license key'));
    }
}
// ============================================
// RENDER KEY ROWS (shared by All + Pribadi tables)
// ============================================
function renderKeyRows(keys, tbodyId) {
    if (!keys.length) {
        document.getElementById(tbodyId).innerHTML = '<tr><td colspan="6" class="empty-state">Tidak ada license key ditemukan.</td></tr>';
        return;
    }
    document.getElementById(tbodyId).innerHTML = keys.map(k => {
        const deviceIds = k.device_ids || [];
        const deviceDisplay = deviceIds.length ? deviceIds.join(', ') : '—';
        const cls = k.status === 'active' ? 'active' : k.status === 'paused' ? 'paused' : 'ban';
        const deviceCount = k.devices || 0;
        const maxDev = k.max_devices || 1;
        const usageColor = deviceCount >= maxDev ? 'color:var(--red);' : 'color:var(--green);';
        const canManage = isKeyOwner(k);
        const isExpiredKey = k.expires !== 'PERMANENT' && new Date(k.expires) <= new Date();
        const expiryCls = isExpiredKey ? 'expiry-expired' : '';

        return `<tr>
            <td><span class="key-highlight">${esc(k.key)}</span><div style="font-size:10px;color:var(--muted2);margin-top:2px;">${esc(k.tag)}</div></td>
            <td style="font-size:11px;" class="${expiryCls}">${k.expires === 'PERMANENT' ? '♾️ Permanent' : new Date(k.expires).toLocaleString()}</td>
            <td style="${usageColor} font-weight:700;">${deviceCount} / ${maxDev}</td>
            <td style="font-size:10px;color:var(--muted2);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(deviceDisplay)}</td>
            <td><span class="badge ${cls}">${k.status}</span></td>
            <td>
                <div class="actions">
                    ${canManage ? `
                        <button class="btn-act extend" onclick="openExtendModal('key','${k.id}','Key · ${esc(k.key)}')">⏳ Perpanjang</button>
                        <button class="btn-act" onclick="keyAction('${k.id}','reset_devices')">Reset</button>
                        <button class="btn-act" onclick="keyAction('${k.id}','${k.status === 'paused' ? 'unpause' : 'pause'}')">${k.status === 'paused' ? 'Unpause' : 'Pause'}</button>
                        <button class="btn-act danger" onclick="keyAction('${k.id}','delete')">Delete</button>
                    ` : `<span style="color:var(--muted2);font-size:11px;">No action</span>`}
                </div>
            </td>
        </tr>`;
    }).join('');
}

function renderKeys() {
    if (!currentUser) return;
    const search = (document.getElementById('search')?.value || '').toLowerCase();
    let keys = getMyKeys();
    if (search) keys = keys.filter(k => (k.key + ' ' + k.tag).toLowerCase().includes(search));
    renderKeyRows(keys, 'keyRows');
}

function renderMyKeys() {
    if (!currentUser) return;
    const search = (document.getElementById('searchMyKeys')?.value || '').toLowerCase();
    let keys = getPrivateKeys();
    if (search) keys = keys.filter(k => (k.key + ' ' + k.tag).toLowerCase().includes(search));
    renderKeyRows(keys, 'myKeyRows');
}

// ============================================
// KEY ACTION
// ============================================
async function keyAction(id, action) {
    if (!currentUser) { alert('❌ Anda harus login terlebih dahulu!'); return; }

    const keyRef = db.collection('keys').doc(id);
    const keyDoc = await keyRef.get();
    if (!keyDoc.exists) { alert('❌ Key tidak ditemukan!'); return; }

    const keyData = keyDoc.data();
    if (!isKeyOwner(keyData)) { alert('❌ Anda tidak memiliki izin untuk mengelola key ini!'); return; }
    if (action === 'delete' && !confirm('Hapus key ini?')) return;

    const actorName = isOwner() ? 'Owner' : (userData?.username || 'User');

    try {
        if (action === 'delete') {
            await keyRef.delete();
            await logActivity('Deleted Key', keyData.key, actorName, keyData.parentAdminId);
            alert('✅ Key deleted!');
        } else if (action === 'pause') {
            await keyRef.update({ status: 'paused' });
            await logActivity('Paused Key', keyData.key, actorName, keyData.parentAdminId);
            alert('⏸️ Key paused!');
        } else if (action === 'unpause') {
            await keyRef.update({ status: 'active' });
            await logActivity('Unpaused Key', keyData.key, actorName, keyData.parentAdminId);
            alert('▶️ Key unpaused!');
        } else if (action === 'reset_devices') {
            await keyRef.update({ devices: 0, device_ids: [] });
            await logActivity('Reset Devices', keyData.key, actorName, keyData.parentAdminId);
            alert('🔄 Devices reset!');
        }
        refresh();
    } catch (error) {
        alert('❌ Error: ' + error.message);
    }
}

function logActivity(action, details, actor, parentAdminId) {
    return db.collection('activities').add({
        action, details, actor,
        parentAdminId: parentAdminId || null,
        timestamp: ServerValue.serverTimestamp()
    });
}

// ============================================
// BULK ACTION
// ============================================
async function bulk(action) {
    if (!currentUser) { alert('❌ Anda harus login terlebih dahulu!'); return; }

    const keysToProcess = getMyKeys();
    if (keysToProcess.length === 0) { alert('❌ Tidak ada keys untuk di-' + action + '!'); return; }
    if (!confirm(`Yakin ingin ${action} semua ${keysToProcess.length} keys?`)) return;

    const batch = db.batch();
    const actorName = isOwner() ? 'Owner' : (userData?.username || 'User');

    keysToProcess.forEach(k => {
        const ref = db.collection('keys').doc(k.id);
        if (action === 'reset') batch.update(ref, { devices: 0, device_ids: [] });
        else if (action === 'pause') batch.update(ref, { status: 'paused' });
        else if (action === 'unpause') batch.update(ref, { status: 'active' });
    });

    await batch.commit();
    await logActivity('Bulk ' + action, keysToProcess.length + ' keys by ' + actorName, actorName, isAdmin() ? currentUser.uid : (userData?.parentAdminId || null));

    alert('✅ Bulk ' + action + ' selesai untuk ' + keysToProcess.length + ' keys!');
    refresh();
}

// ============================================
// RESELLERS  (viewable/manageable by Owner + Admin-of-tree)
// ============================================
function loadResellers() {
    if (!isOwner() && !isAdmin()) return;
    const list = dbData.resellers;
    const canEditCredit = isOwner() || isAdmin(); // Admin may fund resellers in their own tree.

    if (!list.length) {
        document.getElementById('resRows').innerHTML = '<tr><td colspan="6" class="empty-state">Belum ada reseller.</td></tr>';
        return;
    }
    document.getElementById('resRows').innerHTML = list.map(r => {
        const isExpired = r.until && r.until !== 'PERMANENT' && new Date(r.until) <= new Date();
        const statusForBadge = isExpired ? 'expired' : (r.status || 'active');
        return `
        <tr>
            <td>
                <b>${esc(r.username)}</b>
                <div style="font-size:10px;color:var(--muted2);">📧 ${esc(r.email || 'N/A')}</div>
                <div style="font-size:10px;color:var(--green);">💰 ${formatCredit(r.credit)}</div>
            </td>
            <td>${formatCredit(r.credit)}</td>
            <td>${r.createdKeys || 0}</td>
            <td style="font-size:11px;" class="${isExpired ? 'expiry-expired' : ''}">${r.until === 'PERMANENT' ? '♾️ Permanent' : (r.until ? new Date(r.until).toLocaleString() : 'N/A')}</td>
            <td><span class="badge ${statusForBadge === 'active' ? 'active' : statusForBadge === 'expired' ? 'expired' : 'ban'}">${statusForBadge}</span></td>
            <td>
                <div class="actions">
                    <button class="btn-act extend" onclick="openExtendModal('reseller','${r.id}','Akun Reseller · ${esc(r.username)}')">⏳ Perpanjang</button>
                    ${canEditCredit ? `<button class="btn-act" onclick="editReseller('${r.id}','credit')">Credit</button>` : ''}
                    <button class="btn-act" onclick="editReseller('${r.id}','status')">${r.status === 'ban' ? 'Unban' : 'Ban'}</button>
                    <button class="btn-act danger" onclick="editReseller('${r.id}','delete')">Delete</button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

async function editReseller(id, action) {
    if (!isOwner() && !isAdmin()) { alert('❌ Hanya Owner/Admin yang bisa mengelola reseller!'); return; }

    const resRef = db.collection('resellers').doc(id);
    const resDoc = await resRef.get();
    if (!resDoc.exists) { alert('❌ Reseller tidak ditemukan!'); return; }

    const data = resDoc.data();

    // Admin may only manage resellers in their own tree.
    if (isAdmin() && data.parentAdminId !== currentUser.uid) {
        alert('❌ Anda tidak memiliki akses ke reseller ini!');
        return;
    }

    const username = data.username || 'Unknown';
    const uid = data.userId || id;
    const actorName = isOwner() ? 'Owner' : (userData?.username || 'Admin');
    const parentAdminId = data.parentAdminId || null;

    try {
        if (action === 'credit') {
            if (!isOwner() && !isAdmin()) { alert('❌ Hanya Owner/Admin yang dapat mengatur kredit reseller!'); return; }

            const val = prompt('Set kredit untuk ' + username + ' (angka, atau ketik "unlimited" / "∞")');
            if (val === null) return;

            const parsed = parseCreditInput(val);
            if (parsed === null) { alert('❌ Nilai kredit tidak valid! Gunakan angka ≥ 0, atau "unlimited" / "∞".'); return; }
            if (isUnlimitedCredit(parsed) && !isOwner()) { alert('❌ Hanya Owner yang boleh memberi kredit unlimited!'); return; }

            await resRef.update({ credit: parsed, updatedAt: ServerValue.serverTimestamp() });
            await db.collection('users').doc(uid).set({
                status: data.status || 'active', resellerId: uid, username, email: data.email || '',
                role: 'reseller', updatedAt: ServerValue.serverTimestamp()
            }, { merge: true });
            await logActivity('Updated Credit', username + ' → ' + formatCredit(parsed), actorName, parentAdminId);

            alert('✅ Kredit diperbarui menjadi ' + formatCredit(parsed));
            refresh();
            return;
        }

        if (action === 'status') {
            const newStatus = data.status === 'ban' ? 'active' : 'ban';
            await resRef.update({ status: newStatus, updatedAt: ServerValue.serverTimestamp() });
            await db.collection('users').doc(uid).set({
                status: newStatus, role: 'reseller', username, email: data.email || '', resellerId: uid,
                updatedAt: ServerValue.serverTimestamp()
            }, { merge: true });
            await logActivity('Toggled Status', username + ' → ' + newStatus, actorName, parentAdminId);
            alert(newStatus === 'ban' ? '🔒 Reseller dibanned. Login diblokir.' : '✅ Reseller diaktifkan kembali.');
            refresh();
            return;
        }

        if (action === 'delete') {
            if (!confirm('Hapus reseller "' + username + '"?\n\nAkun tidak bisa login lagi setelah dihapus.')) return;
            await db.collection('users').doc(uid).delete();
            await resRef.delete();
            await logActivity('Deleted Reseller', username + ' | UID: ' + uid, actorName, parentAdminId);
            if (currentUser && uid === currentUser.uid) await auth.signOut();
            alert('🗑️ Reseller dihapus. Login untuk "' + username + '" diblokir.');
            refresh();
            return;
        }
    } catch (error) {
        console.error('❌ Reseller action error:', error);
        alert('❌ Error: ' + (error.message || error));
    }
}

async function createReseller() {
    if (!currentUser) { alert('❌ Anda harus login terlebih dahulu!'); return; }
    if (!isOwner() && !isAdmin()) { alert('❌ Hanya Owner/Admin yang bisa membuat reseller!'); return; }

    const u = document.getElementById('ru').value.trim();
    const p = document.getElementById('rp').value;
    const creditRaw = document.getElementById('rc').value;
    const status = document.getElementById('rs').value;
    const period = document.getElementById('rd').value;
    const amount = parseInt(document.getElementById('ra').value) || 1;

    if (!u || !p) { alert('❌ Username dan password harus diisi!'); return; }
    if (u.length < 3) { alert('❌ Username minimal 3 karakter!'); return; }
    if (p.length < 6) { alert('❌ Password minimal 6 karakter!'); return; }

    const credit = parseCreditInput(creditRaw);
    if (credit === null) { alert('❌ Nilai kredit tidak valid! Gunakan angka ≥ 0, atau "unlimited" / "∞".'); return; }
    if (isUnlimitedCredit(credit) && !isOwner()) {
        alert('❌ Hanya Owner yang dapat memberikan kredit Unlimited!');
        return;
    }

    const existing = dbData.resellers.some(r => r.username === u);
    if (existing) { alert('❌ Username "' + u + '" sudah digunakan!'); return; }

    const email = u + '@reseller.com';

    let until = 'PERMANENT';
    if (period !== 'permanent') {
        const now = new Date();
        if (period === 'hours') now.setHours(now.getHours() + amount);
        else if (period === 'day') now.setDate(now.getDate() + amount);
        else if (period === 'monthly') now.setMonth(now.getMonth() + amount);
        else if (period === 'yearly') now.setFullYear(now.getFullYear() + amount);
        until = now.toISOString();
    }

    try {
        const secondaryApp = apiSecondaryApp || createSecondaryApp();
        const secondaryAuth = secondaryApp.auth();
        const userCred = await secondaryAuth.createUserWithEmailAndPassword(email, p);
        const uid = userCred.user.uid;
        await secondaryAuth.signOut();

        const parentAdminId = isAdmin() ? currentUser.uid : null;

        const resellerRef = db.collection('resellers').doc(uid);
        await resellerRef.set({
            username: u, email, userId: uid, credit,
            createdKeys: 0, until, status,
            createdBy: currentUser.uid,
            createdByRole: isOwner() ? 'owner' : 'admin',
            parentAdminId,
            createdAt: ServerValue.serverTimestamp(),
            updatedAt: ServerValue.serverTimestamp()
        });

        await db.collection('users').doc(uid).set({
            username: u, email, role: 'reseller', status,
            resellerId: uid, parentAdminId,
            createdBy: currentUser.uid,
            createdAt: ServerValue.serverTimestamp(),
            updatedAt: ServerValue.serverTimestamp()
        });

        const actorName = isOwner() ? 'Owner' : (userData?.username || 'Admin');
        await logActivity('Created Reseller', u + ' | ' + email + ' | 💰 ' + formatCredit(credit), actorName, parentAdminId);

        alert('✅ Reseller ' + u + ' dibuat!\n📧 Email: ' + email + '\n🔑 Password: ' + p + '\n💰 Credit: ' + formatCredit(credit));
        document.getElementById('ru').value = '';
        document.getElementById('rp').value = '';
        document.getElementById('rc').value = '100';
        refresh();

    } catch (error) {
        console.error('❌ Create reseller error:', error);
        let errorMsg = error.message;
        if (error.code === 'auth/email-already-in-use') errorMsg = 'Email ' + email + ' sudah digunakan! Coba username lain.';
        else if (error.code === 'auth/weak-password') errorMsg = 'Password terlalu lemah! Minimal 6 karakter.';
        else if (error.code === 'auth/operation-not-allowed') errorMsg = 'Email/Password authentication belum di-enable.';
        alert('❌ Error: ' + errorMsg);
    }
}

// ============================================
// ADMINS  (Owner only)
// ============================================
function loadAdmins() {
    if (!isOwner()) return;
    const list = dbData.admins;
    const el = document.getElementById('adminRows');
    if (!el) return;

    if (!list.length) {
        el.innerHTML = '<tr><td colspan="6" class="empty-state">Belum ada akun Admin.</td></tr>';
        return;
    }
    el.innerHTML = list.map(a => {
        // Live count from the reseller tree Owner already listens to — never stale.
        const resellerCount = dbData.resellers.filter(r => r.parentAdminId === (a.userId || a.id)).length;
        const untilDisplay = !a.until || a.until === 'PERMANENT' ? '♾️ Permanent' : new Date(a.until).toLocaleString();
        const isExpired = a.until && a.until !== 'PERMANENT' && new Date(a.until) <= new Date();
        const statusForBadge = isExpired ? 'expired' : (a.status || 'active');
        return `
        <tr>
            <td><b>${esc(a.username)}</b><div style="font-size:10px;color:var(--muted2);">📧 ${esc(a.email || 'N/A')}</div></td>
            <td>${resellerCount}</td>
            <td>💰 ${formatCredit(a.credit || 0)}</td>
            <td style="font-size:11px;" class="${isExpired ? 'expiry-expired' : ''}">${untilDisplay}</td>
            <td><span class="badge ${statusForBadge === 'active' ? 'active' : statusForBadge === 'expired' ? 'expired' : 'ban'}">${statusForBadge}</span></td>
            <td>
                <div class="actions">
                    <button class="btn-act extend" onclick="openExtendModal('admin','${a.id}','Akun Admin · ${esc(a.username)}')">⏳ Perpanjang</button>
                    <button class="btn-act" onclick="editAdmin('${a.id}','credit')">Credit</button>
                    <button class="btn-act" onclick="editAdmin('${a.id}','status')">${a.status === 'ban' ? 'Unban' : 'Ban'}</button>
                    <button class="btn-act danger" onclick="editAdmin('${a.id}','delete')">Delete</button>
                </div>
            </td>
        </tr>
    `;
    }).join('');
}

async function createAdmin() {
    if (!currentUser || !isOwner()) { alert('❌ Hanya Owner yang bisa membuat akun Admin!'); return; }

    const u = document.getElementById('au').value.trim();
    const p = document.getElementById('ap').value;
    const period = document.getElementById('ad')?.value || 'permanent';
    const amount = parseInt(document.getElementById('aa')?.value) || 1;
    if (!u || !p) { alert('❌ Username dan password harus diisi!'); return; }
    if (u.length < 3) { alert('❌ Username minimal 3 karakter!'); return; }
    if (p.length < 6) { alert('❌ Password minimal 6 karakter!'); return; }

    const existing = dbData.admins.some(a => a.username === u);
    if (existing) { alert('❌ Username "' + u + '" sudah digunakan!'); return; }

    const email = u + '@admin.com';

    let until = 'PERMANENT';
    if (period !== 'permanent') {
        const now = new Date();
        if (period === 'hours') now.setHours(now.getHours() + amount);
        else if (period === 'day') now.setDate(now.getDate() + amount);
        else if (period === 'monthly') now.setMonth(now.getMonth() + amount);
        else if (period === 'yearly') now.setFullYear(now.getFullYear() + amount);
        until = now.toISOString();
    }

    try {
        const secondaryApp = apiSecondaryApp || createSecondaryApp();
        const secondaryAuth = secondaryApp.auth();
        const userCred = await secondaryAuth.createUserWithEmailAndPassword(email, p);
        const uid = userCred.user.uid;
        await secondaryAuth.signOut();

        await db.collection('admins').doc(uid).set({
            username: u, email, userId: uid, status: 'active', until, credit: 0,
            createdBy: currentUser.uid,
            createdAt: ServerValue.serverTimestamp(),
            updatedAt: ServerValue.serverTimestamp()
        });

        await db.collection('users').doc(uid).set({
            username: u, email, role: 'admin', status: 'active',
            createdBy: currentUser.uid,
            createdAt: ServerValue.serverTimestamp(),
            updatedAt: ServerValue.serverTimestamp()
        });

        await logActivity('Created Admin', u + ' | ' + email + ' | Aktif s/d ' + (until === 'PERMANENT' ? 'Permanent' : new Date(until).toLocaleString()), 'Owner', null);

        alert('✅ Admin ' + u + ' dibuat!\n📧 Email: ' + email + '\n🔑 Password: ' + p + '\n⏳ Aktif s/d: ' + (until === 'PERMANENT' ? '♾️ Permanent' : new Date(until).toLocaleString()));
        document.getElementById('au').value = '';
        document.getElementById('ap').value = '';
        if (document.getElementById('aa')) document.getElementById('aa').value = 1;
        refresh();
    } catch (error) {
        console.error('❌ Create admin error:', error);
        let errorMsg = error.message;
        if (error.code === 'auth/email-already-in-use') errorMsg = 'Email ' + email + ' sudah digunakan!';
        else if (error.code === 'auth/weak-password') errorMsg = 'Password terlalu lemah! Minimal 6 karakter.';
        alert('❌ Error: ' + errorMsg);
    }
}

async function editAdmin(id, action) {
    if (!isOwner()) { alert('❌ Hanya Owner yang bisa mengelola Admin!'); return; }

    const ref = db.collection('admins').doc(id);
    const doc = await ref.get();
    if (!doc.exists) { alert('❌ Admin tidak ditemukan!'); return; }
    const data = doc.data();
    const uid = data.userId || id;

    try {
        if (action === 'credit') {
            const val = prompt('Set kredit untuk admin ' + data.username + ' (angka, atau ketik "unlimited" / "∞")');
            if (val === null) return;

            const parsed = parseCreditInput(val);
            if (parsed === null) { alert('❌ Nilai kredit tidak valid! Gunakan angka ≥ 0, atau "unlimited" / "∞".'); return; }

            await ref.update({ credit: parsed, updatedAt: ServerValue.serverTimestamp() });
            await logActivity('Updated Admin Credit', data.username + ' → ' + formatCredit(parsed), 'Owner', null);
            alert('✅ Kredit admin ' + data.username + ' diperbarui menjadi ' + formatCredit(parsed));
            refresh();
            return;
        }
        if (action === 'status') {
            const newStatus = data.status === 'ban' ? 'active' : 'ban';
            await ref.update({ status: newStatus, updatedAt: ServerValue.serverTimestamp() });
            await db.collection('users').doc(uid).set({ status: newStatus, updatedAt: ServerValue.serverTimestamp() }, { merge: true });
            await logActivity('Toggled Admin Status', data.username + ' → ' + newStatus, 'Owner', null);
            alert(newStatus === 'ban' ? '🔒 Admin dibanned.' : '✅ Admin diaktifkan kembali.');
            refresh();
            return;
        }
        if (action === 'delete') {
            if (!confirm('Hapus admin "' + data.username + '"?\n\nSeluruh reseller di bawah admin ini TIDAK ikut terhapus, tapi akan kehilangan admin induknya. Pastikan Anda memindahkan mereka terlebih dulu bila perlu.')) return;
            await db.collection('users').doc(uid).delete();
            await ref.delete();
            await logActivity('Deleted Admin', data.username + ' | UID: ' + uid, 'Owner', null);
            if (currentUser && uid === currentUser.uid) await auth.signOut();
            alert('🗑️ Admin dihapus.');
            refresh();
            return;
        }
    } catch (error) {
        alert('❌ Error: ' + (error.message || error));
    }
}

// ============================================
// OWNER DEVELOPER CREDIT (unlimited-aware)
// ============================================
async function saveOwnerCredit() {
    if (!currentUser || !isOwner()) { alert('❌ Hanya Owner yang bisa mengatur kredit developer!'); return; }

    const raw = document.getElementById('creditInput').value;
    const v = parseCreditInput(raw);
    if (v === null) { alert('❌ Nilai kredit tidak valid! Gunakan angka ≥ 0, atau "unlimited" / "∞".'); return; }

    try {
        await db.collection('system').doc('stats').set({ credit: v, updatedAt: ServerValue.serverTimestamp() }, { merge: true });
        await logActivity('Updated Credit', 'Owner → ' + formatCredit(v), 'Owner', null);
        alert('✅ Kredit Owner diperbarui menjadi ' + formatCredit(v) + '!');
        refresh();
    } catch (error) {
        alert('❌ Error: ' + error.message);
    }
}

// ============================================
// PERPANJANG / EXTEND  (Key, Admin account, Reseller account)
// - Key: bisa dilakukan Owner / Admin (tree) / Reseller (miliknya sendiri)
// - Akun Admin: hanya Owner
// - Akun Reseller: Owner + Admin (untuk reseller di bawah treenya)
// ============================================
let extendContext = null; // { type: 'key' | 'admin' | 'reseller', id, currentUntil }

// BUGFIX (v9.1.1): previously the current "until"/"expires" value was passed
// straight into the onclick="..." HTML attribute via JSON.stringify(...).
// Since that attribute is itself delimited with double quotes, and
// JSON.stringify() on any real date string (or on 'PERMANENT') also wraps
// the value in double quotes, the inner quotes closed the attribute early
// and truncated the onclick JS into an incomplete statement. Result: the
// button silently did nothing when clicked, for every key/admin/reseller
// that actually had a set expiry (i.e. almost always — this was the
// "Perpanjang gabisa dipencet" bug). Fix: only pass the id/type/label
// through the attribute, and look up the current expiry from the
// already-loaded data instead of round-tripping it through HTML.
function openExtendModal(type, id, label) {
    let currentUntil = 'PERMANENT';
    if (type === 'key') {
        const k = dbData.keys.find(x => x.id === id);
        if (k) currentUntil = k.expires || 'PERMANENT';
    } else if (type === 'reseller') {
        const r = dbData.resellers.find(x => x.id === id);
        if (r) currentUntil = r.until || 'PERMANENT';
    } else if (type === 'admin') {
        const a = dbData.admins.find(x => x.id === id);
        if (a) currentUntil = a.until || 'PERMANENT';
    }

    extendContext = { type, id, currentUntil };
    setText('extendTitle', '⏳ Perpanjang');
    setText('extendSubtitle', 'Perpanjang masa aktif untuk: ' + label);
    setText('extendCurrentUntil', (currentUntil === 'PERMANENT' || !currentUntil) ? '♾️ Permanent' : new Date(currentUntil).toLocaleString());

    const periodEl = document.getElementById('extendPeriod');
    const amountEl = document.getElementById('extendAmount');
    const fromNowEl = document.getElementById('extendFromNow');
    const customEl = document.getElementById('extendCustomDate');
    if (periodEl) periodEl.value = 'monthly';
    if (amountEl) amountEl.value = 1;
    if (fromNowEl) fromNowEl.checked = false;
    if (customEl) {
        const base = (currentUntil && currentUntil !== 'PERMANENT' && !Number.isNaN(new Date(currentUntil).getTime()) && new Date(currentUntil) > new Date())
            ? new Date(currentUntil) : new Date();
        customEl.value = toDatetimeLocalValue(base);
    }
    extendPeriodUI();

    const overlay = document.getElementById('extendOverlay');
    if (overlay) overlay.style.display = 'flex';
}

// Formats a Date as "YYYY-MM-DDTHH:mm" (local time) for an <input type="datetime-local">.
function toDatetimeLocalValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function closeExtendModal() {
    const overlay = document.getElementById('extendOverlay');
    if (overlay) overlay.style.display = 'none';
    extendContext = null;
}

function extendPeriodUI() {
    const v = document.getElementById('extendPeriod')?.value;
    const amountBox = document.getElementById('extendAmountBox');
    const customBox = document.getElementById('extendCustomBox');
    const fromNowRow = document.getElementById('extendFromNowRow');
    if (amountBox) amountBox.style.display = (v === 'permanent' || v === 'custom') ? 'none' : 'block';
    if (customBox) customBox.style.display = v === 'custom' ? 'block' : 'none';
    if (fromNowRow) fromNowRow.style.display = (v === 'permanent' || v === 'custom') ? 'none' : 'block';
}

// Extends from the current expiry date if it's still in the future (stacking),
// otherwise (or if "from now" is checked, or it's already permanent/expired) starts from now.
// period === 'custom' bypasses all of that: the picked date/time IS the new expiry.
function computeExtendedUntil(currentUntil, period, amount, fromNow, customDateTime) {
    if (period === 'permanent') return 'PERMANENT';

    if (period === 'custom') {
        if (!customDateTime) throw new Error('Pilih tanggal & jam terlebih dahulu!');
        const custom = new Date(customDateTime);
        if (Number.isNaN(custom.getTime())) throw new Error('Tanggal & jam tidak valid!');
        return custom.toISOString();
    }

    let base;
    if (fromNow || !currentUntil || currentUntil === 'PERMANENT') {
        base = new Date();
    } else {
        base = new Date(currentUntil);
        if (Number.isNaN(base.getTime()) || base < new Date()) base = new Date();
    }
    if (period === 'hours') base.setHours(base.getHours() + amount);
    else if (period === 'day') base.setDate(base.getDate() + amount);
    else if (period === 'week') base.setDate(base.getDate() + (amount * 7));
    else if (period === 'monthly') base.setMonth(base.getMonth() + amount);
    else if (period === 'yearly') base.setFullYear(base.getFullYear() + amount);
    return base.toISOString();
}

async function confirmExtend() {
    if (!extendContext) return;
    const period = document.getElementById('extendPeriod').value;
    const amount = parseInt(document.getElementById('extendAmount').value) || 1;
    const fromNow = document.getElementById('extendFromNow').checked;
    const customDateTime = document.getElementById('extendCustomDate')?.value || '';

    let newUntil;
    try {
        newUntil = computeExtendedUntil(extendContext.currentUntil, period, amount, fromNow, customDateTime);
    } catch (err) {
        alert('❌ ' + err.message);
        return;
    }

    const btn = document.getElementById('extendConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Memproses…'; }

    try {
        if (extendContext.type === 'key') {
            await extendKeyCommit(extendContext.id, newUntil);
        } else if (extendContext.type === 'admin') {
            await extendAdminCommit(extendContext.id, newUntil);
        } else if (extendContext.type === 'reseller') {
            await extendResellerCommit(extendContext.id, newUntil);
        }
        alert('✅ Berhasil diperpanjang hingga ' + (newUntil === 'PERMANENT' ? '♾️ Permanent' : new Date(newUntil).toLocaleString()));
        closeExtendModal();
        refresh();
    } catch (error) {
        console.error('❌ Extend error:', error);
        alert('❌ Error: ' + (error.message || error));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✓ Perpanjang'; }
    }
}

async function extendKeyCommit(id, newUntil) {
    const keyRef = db.collection('keys').doc(id);
    const doc = await keyRef.get();
    if (!doc.exists) throw new Error('Key tidak ditemukan!');
    const data = doc.data();
    if (!isKeyOwner(data)) throw new Error('Anda tidak memiliki izin untuk memperpanjang key ini!');

    await keyRef.update({ expires: newUntil, updatedAt: ServerValue.serverTimestamp() });

    const actorName = isOwner() ? 'Owner' : (userData?.username || 'User');
    await logActivity('Extended Key', data.key + ' → ' + (newUntil === 'PERMANENT' ? 'Permanent' : new Date(newUntil).toLocaleString()), actorName, data.parentAdminId || null);
}

async function extendAdminCommit(id, newUntil) {
    if (!isOwner()) throw new Error('Hanya Owner yang bisa memperpanjang akun Admin!');

    const ref = db.collection('admins').doc(id);
    const doc = await ref.get();
    if (!doc.exists) throw new Error('Admin tidak ditemukan!');
    const data = doc.data();
    const uid = data.userId || id;

    const update = { until: newUntil, updatedAt: ServerValue.serverTimestamp() };
    if (data.status === 'expired') update.status = 'active';
    await ref.update(update);

    if (data.status === 'expired') {
        try {
            await db.collection('users').doc(uid).set({ status: 'active', updatedAt: ServerValue.serverTimestamp() }, { merge: true });
        } catch (_) { /* best-effort re-activation of the login record */ }
    }

    await logActivity('Extended Admin', data.username + ' → ' + (newUntil === 'PERMANENT' ? 'Permanent' : new Date(newUntil).toLocaleString()), 'Owner', null);
}

async function extendResellerCommit(id, newUntil) {
    if (!isOwner() && !isAdmin()) throw new Error('Hanya Owner/Admin yang bisa memperpanjang reseller!');

    const ref = db.collection('resellers').doc(id);
    const doc = await ref.get();
    if (!doc.exists) throw new Error('Reseller tidak ditemukan!');
    const data = doc.data();

    if (isAdmin() && data.parentAdminId !== currentUser.uid) {
        throw new Error('Anda tidak memiliki akses ke reseller ini!');
    }

    const uid = data.userId || id;
    const update = { until: newUntil, updatedAt: ServerValue.serverTimestamp() };
    if (data.status === 'expired') update.status = 'active';
    await ref.update(update);

    if (data.status === 'expired') {
        try {
            await db.collection('users').doc(uid).set({ status: 'active', updatedAt: ServerValue.serverTimestamp() }, { merge: true });
        } catch (_) { /* best-effort re-activation of the login record */ }
    }

    const actorName = isOwner() ? 'Owner' : (userData?.username || 'Admin');
    await logActivity('Extended Reseller', data.username + ' → ' + (newUntil === 'PERMANENT' ? 'Permanent' : new Date(newUntil).toLocaleString()), actorName, data.parentAdminId || null);
}

// ============================================
// REFRESH
// ============================================
function refresh() {
    if (!currentUser) return;
    updateStatsUI();
    renderKeys();
    renderMyKeys();
    loadResellers();
    if (isOwner()) loadAdmins();
    renderActivities();
    updateRanking();
}

// ============================================
// SHOW APP  (role-based nav + widget visibility)
// ============================================
function showApp() {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'block';

    const owner = isOwner();
    const admin = isAdmin();

    document.getElementById('navOwner').style.display = owner ? 'flex' : 'none';
    document.getElementById('navAdmin').style.display = admin ? 'flex' : 'none';
    document.getElementById('navReseller').style.display = (!owner && !admin) ? 'flex' : 'none';

    const displayName = owner ? 'Owner' : admin ? ('Admin · ' + (userData?.username || '')) : (userData?.username || currentUser?.email || 'User');
    setText('who', displayName);
    setText('avatar', (owner ? 'O' : admin ? 'A' : (userData?.username?.[0] || currentUser?.email?.[0] || 'U')).toUpperCase());

    const rankPanel = document.getElementById('rankPanel');
    if (rankPanel) rankPanel.style.display = (owner || admin) ? 'block' : 'none';

    setText('addTitle', (owner || admin) ? 'Add License Key' : 'Create License Key');

    if (window.activityUnsubscribe) { window.activityUnsubscribe(); window.activityUnsubscribe = null; }
    startListeners();

    console.log('🖥️ App shown, Role:', owner ? 'owner' : admin ? 'admin' : 'reseller');
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', function() {
    durationUI();
    startListeners();
    console.log('🚀 License Panel v9 ready — roles: Owner / Admin / Reseller');
});

// Global exports
window.doLogin = doLogin;
window.logout = logout;
window.go = go;
window.toggleSidebar = toggleSidebar;
window.mode = mode;
window.durationUI = durationUI;
window.createKey = createKey;
window.copyResult = copyResult;
window.renderKeys = renderKeys;
window.renderMyKeys = renderMyKeys;
window.keyAction = keyAction;
window.bulk = bulk;
window.editReseller = editReseller;
window.createReseller = createReseller;
window.createAdmin = createAdmin;
window.editAdmin = editAdmin;
window.saveOwnerCredit = saveOwnerCredit;
window.refresh = refresh;
window.isOwner = isOwner;
window.isAdmin = isAdmin;
window.isReseller = isReseller;
window.isKeyOwner = isKeyOwner;
window.verifyResellerAccess = verifyResellerAccess;
window.getMyResellerDoc = getMyResellerDoc;
window.openExtendModal = openExtendModal;
window.closeExtendModal = closeExtendModal;
window.extendPeriodUI = extendPeriodUI;
window.confirmExtend = confirmExtend;
