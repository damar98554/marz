// ===== AUTH LOGIC (Owner / Admin / Reseller) =====
let currentUser = null;
let userRole = null;
let userData = null;

// ============================================
// CREDIT HELPERS (shared with app.js)
// Unlimited credit is stored as the literal string 'unlimited'.
// Never store or display fake numbers (0, 999999, etc.) for it.
// ============================================
function parseCreditInput(raw) {
    const v = String(raw ?? '').trim().toLowerCase();
    if (v === 'unlimited' || v === '∞' || v === 'infinity' || v === 'inf') {
        return 'unlimited';
    }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || String(raw).trim() === '') return null;
    return Math.floor(n);
}

function isUnlimitedCredit(v) {
    return v === 'unlimited' || v === '∞';
}

function formatCredit(v) {
    return isUnlimitedCredit(v) ? '∞ Unlimited' : (Number(v) || 0).toLocaleString('id-ID');
}

// Login function – supports username or email for all roles
async function doLogin() {
    const input = document.getElementById('lu').value.trim();
    const password = document.getElementById('lp').value;
    const errEl = document.getElementById('err');
    const btn = document.getElementById('loginBtn');

    if (!input || !password) {
        errEl.textContent = '❌ Lengkapi semua kolom!';
        return;
    }

    try {
        errEl.textContent = '';
        if (btn) { btn.disabled = true; btn.classList.add('loading'); btn.textContent = 'Signing in…'; }

        let userCredential;

        if (input.includes('@')) {
            // Full email given directly (typically the Owner's real email).
            userCredential = await auth.signInWithEmailAndPassword(input, password);
        } else {
            // Username-only login: Reseller and Admin use deterministic
            // emails (<username>@reseller.com / <username>@admin.com) so the
            // account directory is never exposed to unauthenticated visitors.
            // We don't know the role up front, so try Reseller first, then
            // fall back to Admin on a not-found/invalid-credential result.
            try {
                userCredential = await auth.signInWithEmailAndPassword(input + '@reseller.com', password);
            } catch (firstError) {
                const retryableCodes = ['auth/user-not-found', 'auth/invalid-credential', 'auth/wrong-password'];
                if (retryableCodes.includes(firstError.code)) {
                    try {
                        userCredential = await auth.signInWithEmailAndPassword(input + '@admin.com', password);
                    } catch (secondError) {
                        // Neither account/password combination worked — surface the
                        // original (Reseller-domain) error, which is the more likely case.
                        throw firstError;
                    }
                } else {
                    throw firstError;
                }
            }
        }

        currentUser = userCredential.user;

        const ok = await validateSession(currentUser, errEl);
        if (!ok) {
            if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '⟶  Login'; }
            return;
        }

        watchAuthorization(currentUser.uid);
        showApp();
        refresh();

    } catch (error) {
        console.error('Login error:', error);

        let msg = error.message;
        if (error.code === 'auth/user-not-found') msg = 'Akun tidak ditemukan!';
        else if (error.code === 'auth/wrong-password') msg = 'Password salah!';
        else if (error.code === 'auth/invalid-email') msg = 'Format email/username tidak valid!';
        else if (error.code === 'auth/invalid-credential') msg = 'Kredensial tidak valid! Periksa email/username dan password.';
        else if (error.code === 'permission-denied') msg = 'Akses ditolak.';
        else if (error.code === 'auth/too-many-requests') msg = 'Terlalu banyak percobaan. Coba lagi nanti.';

        errEl.textContent = '❌ ' + msg;
    } finally {
        if (btn) { btn.disabled = false; btn.classList.remove('loading'); btn.textContent = '⟶  Login'; }
    }
}

// ============================================
// SESSION VALIDATION — shared by login + auth state listener.
// Handles all three roles: owner, admin, reseller.
// ============================================
async function validateSession(user, errEl) {
    const setErr = (msg) => { if (errEl) errEl.textContent = msg; };

    const userDoc = await db.collection('users').doc(user.uid).get();

    if (!userDoc.exists) {
        await auth.signOut();
        currentUser = null;
        setErr('🔒 Akun tidak/sudah tidak terdaftar.');
        return false;
    }

    userData = userDoc.data();
    userRole = userData.role || 'reseller';

    if (userData.status === 'ban' || userData.status === 'deleted') {
        await auth.signOut();
        currentUser = null; userRole = null; userData = null;
        setErr(userData?.status === 'ban' ? '❌ Akun telah dibanned!' : '🔒 Akun telah dicabut.');
        return false;
    }

    if (userRole === 'admin') {
        const adminDoc = await db.collection('admins').doc(user.uid).get();
        if (!adminDoc.exists || adminDoc.data().status !== 'active') {
            await auth.signOut();
            currentUser = null; userRole = null; userData = null;
            setErr('🔒 Akun admin tidak aktif / telah dihapus Owner.');
            return false;
        }

        const adminData = adminDoc.data();

        // BUGFIX: Admin accounts previously had no expiry check at all — an
        // Admin's "Active Until" (set on creation / via "Perpanjang") was
        // stored but never enforced. Enforce it here, same as Reseller.
        if (adminData.until && adminData.until !== 'PERMANENT') {
            const until = new Date(adminData.until);
            if (!Number.isNaN(until.getTime()) && until <= new Date()) {
                // Best-effort status flag. Firestore Rules only allow the
                // Owner to write to /admins and /users, so this client-side
                // write is expected to be denied — that's fine, we still
                // sign the session out below regardless of whether it lands.
                try {
                    await db.collection('admins').doc(user.uid).update({ status: 'expired', updatedAt: ServerValue.serverTimestamp() });
                } catch (_) { /* denied by rules, ignored on purpose */ }
                try {
                    await db.collection('users').doc(user.uid).set({ status: 'expired', updatedAt: ServerValue.serverTimestamp() }, { merge: true });
                } catch (_) { /* denied by rules, ignored on purpose */ }
                await auth.signOut();
                currentUser = null; userRole = null; userData = null;
                setErr('⏰ Masa aktif akun admin sudah habis. Hubungi Owner untuk perpanjang.');
                return false;
            }
        }

        userData = {
            ...userData, ...adminData, role: 'admin',
            credit: isUnlimitedCredit(adminData.credit) ? 'unlimited' : (Number(adminData.credit) || 0)
        };
    }

    if (userRole === 'reseller') {
        let resellerDoc = await db.collection('resellers').doc(user.uid).get();

        if (!resellerDoc.exists) {
            const legacyQuery = await db.collection('resellers')
                .where('userId', '==', user.uid).limit(1).get();
            resellerDoc = legacyQuery.empty ? null : legacyQuery.docs[0];
        }

        if (!resellerDoc || !resellerDoc.exists) {
            await auth.signOut();
            currentUser = null; userRole = null; userData = null;
            setErr('🔒 Akun reseller telah dihapus Owner/Admin.');
            return false;
        }

        const resellerData = resellerDoc.data();

        if (resellerData.userId && resellerData.userId !== user.uid) {
            await auth.signOut();
            currentUser = null; userRole = null; userData = null;
            setErr('🔒 Ketidakcocokan otorisasi akun.');
            return false;
        }

        if (resellerData.status !== 'active' || userData.status !== 'active') {
            await auth.signOut();
            currentUser = null; userRole = null; userData = null;
            setErr(resellerData.status === 'ban' ? '❌ Akun telah dibanned!' : '🔒 Akun tidak aktif!');
            return false;
        }

        if (resellerData.until && resellerData.until !== 'PERMANENT') {
            const until = new Date(resellerData.until);
            if (!Number.isNaN(until.getTime()) && until <= new Date()) {
                // BUGFIX: these writes can be denied by Firestore Rules depending
                // on who currently owns the record; wrap so a permission error
                // never masks the real "expired" message shown to the user below.
                try {
                    await db.collection('users').doc(user.uid).set({
                        status: 'expired', updatedAt: ServerValue.serverTimestamp()
                    }, { merge: true });
                } catch (_) { /* denied by rules, ignored on purpose */ }
                try {
                    await resellerDoc.ref.update({
                        status: 'expired', updatedAt: ServerValue.serverTimestamp()
                    });
                } catch (_) { /* denied by rules, ignored on purpose */ }
                await auth.signOut();
                currentUser = null; userRole = null; userData = null;
                setErr('⏰ Masa aktif akun sudah habis!');
                return false;
            }
        }

        userData = {
            ...userData,
            username: resellerData.username,
            email: resellerData.email,
            credit: isUnlimitedCredit(resellerData.credit) ? 'unlimited' : (Number(resellerData.credit) || 0),
            parentAdminId: resellerData.parentAdminId || null
        };
    }

    return true;
}

// ============================================
// LIVE AUTHORIZATION WATCHER
// ============================================
function watchAuthorization(uid) {
    if (window.authorizationUnsubscribe) {
        window.authorizationUnsubscribe();
        window.authorizationUnsubscribe = null;
    }

    window.authorizationUnsubscribe = db.collection('users').doc(uid)
        .onSnapshot(async (snap) => {
            if (!snap.exists) {
                console.warn('🔒 Authorization document removed.');
                await auth.signOut();
                return;
            }

            const data = snap.data();

            if (data.status === 'ban' || data.status === 'deleted') {
                console.warn('🔒 Account status changed:', data.status);
                await auth.signOut();
                return;
            }

            if (data.role === 'reseller' && data.status !== 'active') {
                await auth.signOut();
            }
        }, (error) => {
            console.error('Authorization watcher error:', error);
        });
}

// Logout function
async function logout() {
    try {
        await auth.signOut();
        if (window.authorizationUnsubscribe) {
            window.authorizationUnsubscribe();
            window.authorizationUnsubscribe = null;
        }
        currentUser = null;
        userRole = null;
        userData = null;
        document.getElementById('app').style.display = 'none';
        document.getElementById('login').style.display = 'grid';
        document.getElementById('lp').value = '';
        document.getElementById('err').textContent = '';
        document.getElementById('side').classList.remove('open');
    } catch (error) {
        console.error('Logout error:', error);
        alert('❌ Error logging out: ' + error.message);
    }
}

// Auth state listener
auth.onAuthStateChanged(async (user) => {
    if (!user) {
        if (window.authorizationUnsubscribe) {
            window.authorizationUnsubscribe();
            window.authorizationUnsubscribe = null;
        }
        currentUser = null;
        userRole = null;
        userData = null;
        document.getElementById('app').style.display = 'none';
        document.getElementById('login').style.display = 'grid';
        return;
    }

    currentUser = user;

    try {
        const ok = await validateSession(user, null);
        if (!ok) return;

        watchAuthorization(user.uid);
        showApp();
        refresh();
    } catch (error) {
        console.error('❌ Auth state validation error:', error);
        await auth.signOut();
    }
});

function toggleSidebar() {
    const side = document.getElementById('side');
    side.classList.toggle('open');
    if (window.innerWidth > 900) side.style.display = side.style.display === 'none' ? 'flex' : 'none';
}

function go(id, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const target = document.getElementById(id);
    if (target) target.classList.add('active');
    document.querySelectorAll('#side nav button').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
        const b = document.querySelector('#side nav button[data-page="' + id + '"]');
        if (b) b.classList.add('active');
    }
    if (window.innerWidth <= 900) document.getElementById('side').classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    refresh();
}

document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && document.getElementById('login').style.display !== 'none') doLogin();
});

document.addEventListener('click', function(e) {
    const side = document.getElementById('side');
    const hamb = document.querySelector('.hamb');
    if (window.innerWidth <= 900 && side.classList.contains('open')) {
        if (!side.contains(e.target) && !hamb.contains(e.target)) side.classList.remove('open');
    }
});

console.log('🔐 Auth module loaded');
