/**
 * js/data.js
 * ─────────────────────────────────────────────────────
 * Semua fungsi interaksi data menggunakan Firebase Realtime Database.
 * Requires: firebase-config.js (harus dimuat lebih dulu)
 * ─────────────────────────────────────────────────────
 */

/* ════════════════════════════════════════════
   DEVICE ID — identifikasi perangkat voter
════════════════════════════════════════════ */

/**
 * Ambil atau buat Device ID unik untuk perangkat ini.
 * Disimpan di localStorage agar konsisten antar session.
 */
function getDeviceId() {
  let id = localStorage.getItem('ukk_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
    localStorage.setItem('ukk_device_id', id);
  }
  return id;
}

/* ════════════════════════════════════════════
   FOODS — real-time listener & CRUD
════════════════════════════════════════════ */

/**
 * Pasang listener real-time untuk data makanan.
 * Callback dipanggil setiap kali data berubah (termasuk saat pertama kali attach).
 * @param {function} callback - dipanggil dengan array foods yang sudah diurutkan
 * @returns {function} unsubscribe — panggil untuk melepas listener
 */
function onFoodsChange(callback) {
  const ref = db.ref('foods');

  const handler = (snapshot) => {
    const raw = snapshot.val() || {};
    const foods = Object.entries(raw).map(([id, food]) => ({ id, ...food }));
    callback(foods);
  };

  ref.on('value', handler);

  // Kembalikan fungsi untuk melepas listener (untuk cleanup di React)
  return () => ref.off('value', handler);
}

/**
 * Ambil data makanan satu kali (tanpa listener real-time).
 * @returns {Promise<Array>}
 */
async function getFoodsOnce() {
  const snap = await db.ref('foods').once('value');
  const raw  = snap.val() || {};
  return Object.entries(raw).map(([id, food]) => ({ id, ...food }));
}

/**
 * Tambah menu baru ke Firebase.
 * @param {{ name: string, table: string, cook: string }} data
 * @returns {Promise<object>} food yang baru dibuat
 */
async function addFood({ name, table, cook }) {
  const token   = Math.random().toString(36).substr(2, 6);
  const newFood = {
    name:      name.trim(),
    table:     table.trim(),
    cook:      cook.trim(),
    votes:     0,
    token,
    createdAt: firebase.database.ServerValue.TIMESTAMP,
  };
  const ref = await db.ref('foods').push(newFood);
  return { id: ref.key, ...newFood };
}

/**
 * Hapus menu dari Firebase.
 * @param {string} foodId
 */
async function deleteFood(foodId) {
  await db.ref(`foods/${foodId}`).remove();
}

/* ════════════════════════════════════════════
   VOTING — proses vote dengan Firebase transaction
════════════════════════════════════════════ */

/**
 * Proses vote berdasarkan token QR.
 * - Cek localStorage (cepat, offline-first)
 * - Cek voter_records di Firebase (server-side anti-cheat)
 * - Gunakan Firebase transaction untuk increment atomic
 *
 * @param {string} token
 * @returns {Promise<{ ok: boolean, food: object|null, error: string|null }>}
 */
async function processVote(token) {
  // ── 1. Cek lokal dulu (instant, tanpa network) ──────────
  const localVoted = localStorage.getItem('ukk_has_voted');
  if (localVoted) {
    const votedName = localStorage.getItem('ukk_voted_for') || '';
    return {
      ok:    false,
      food:  null,
      error: votedName
        ? `Perangkat ini sudah memberikan vote untuk "${votedName}".`
        : 'Perangkat ini sudah pernah memberikan vote.',
    };
  }

  // ── 2. Cari menu berdasarkan token ──────────────────────
  let foodId, food;
  try {
    const snap = await db.ref('foods')
      .orderByChild('token')
      .equalTo(token)
      .once('value');

    if (!snap.exists()) {
      return { ok: false, food: null, error: 'Token tidak valid / Menu tidak ditemukan!' };
    }

    foodId = Object.keys(snap.val())[0];
    food   = { id: foodId, ...snap.val()[foodId] };
  } catch (e) {
    return { ok: false, food: null, error: 'Gagal terhubung ke server. Periksa koneksi internet.' };
  }

  // ── 3. Cek voter_records di Firebase ────────────────────
  const deviceId  = getDeviceId();
  const voterRef  = db.ref(`voter_records/${deviceId}`);

  try {
    const voterSnap = await voterRef.once('value');
    if (voterSnap.exists()) {
      const d = voterSnap.val();
      // Sinkronkan ke localStorage agar cek lokal efektif berikutnya
      localStorage.setItem('ukk_has_voted',  'true');
      localStorage.setItem('ukk_voted_for',  d.foodName || '');
      return {
        ok:    false,
        food,
        error: `Perangkat ini sudah memberikan vote untuk "${d.foodName || 'menu tersebut'}".`,
      };
    }
  } catch (e) {
    // Jika read voter_records gagal (misal offline), lanjutkan ke step berikutnya
    console.warn('[VoteCheck] Gagal cek voter_records:', e.message);
  }

  // ── 4. Atomic: increment vote + simpan voter record ─────
  try {
    // Increment vote count secara atomic
    await db.ref(`foods/${foodId}/votes`).transaction((current) => (current || 0) + 1);

    // Simpan catatan voter agar tidak bisa vote lagi
    await voterRef.set({
      foodId,
      foodName:  food.name,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });

    // Tandai lokal
    localStorage.setItem('ukk_has_voted', 'true');
    localStorage.setItem('ukk_voted_for', food.name);

    // Kirim notifikasi ke proyektor
    await db.ref('last_vote').set({
      name:      food.name,
      cook:      food.cook,
      table:     food.table,
      timestamp: firebase.database.ServerValue.TIMESTAMP,
    });

    return { ok: true, food };

  } catch (e) {
    console.error('[VoteProcess] Error:', e);
    return { ok: false, food, error: 'Gagal menyimpan vote. Silakan coba lagi.' };
  }
}

/* ════════════════════════════════════════════
   ADMIN — reset votes
════════════════════════════════════════════ */

/**
 * Reset semua vote menjadi 0 dan hapus semua catatan voter.
 * Setelah reset, semua perangkat bisa vote lagi.
 * @param {Array} foods - array foods saat ini (untuk mendapatkan ID-nya)
 */
async function resetAllVotes(foods) {
  // Buat batch update: set semua votes = 0
  const updates = {};
  foods.forEach(f => {
    updates[`foods/${f.id}/votes`] = 0;
  });

  await db.ref().update(updates);

  // Hapus semua voter records → semua perangkat bisa vote lagi
  await db.ref('voter_records').remove();

  // Hapus data vote terakhir di proyektor
  await db.ref('last_vote').remove();

  // Bersihkan localStorage lokal
  localStorage.removeItem('ukk_has_voted');
  localStorage.removeItem('ukk_voted_for');
}

/**
 * Listener untuk notifikasi vote terakhir (untuk proyektor).
 * @param {function} callback - dipanggil dengan data { name, cook, table, timestamp }
 * @returns {function} unsubscribe
 */
function onLastVoteChange(callback) {
  const ref     = db.ref('last_vote');
  const handler = (snap) => { if (snap.exists()) callback(snap.val()); };
  ref.on('value', handler);
  return () => ref.off('value', handler);
}
