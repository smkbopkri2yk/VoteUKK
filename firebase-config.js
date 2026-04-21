/**
 * js/firebase-config.js
 * Konfigurasi Firebase – UKK Kuliner Voting System
 */

const firebaseConfig = {
  apiKey:            "AIzaSyC1H1HF7BtORxpy3J0JZPpfbcHFIj5qpGE",
  authDomain:        "voteukk.firebaseapp.com",
  databaseURL:       "https://voteukk-default-rtdb.firebaseio.com",
  projectId:         "voteukk",
  storageBucket:     "voteukk.firebasestorage.app",
  messagingSenderId: "459245028959",
  appId:             "1:459245028959:web:1c1e32583d8401aaa0fdea",
  measurementId:     "G-6VPJNJFJRS",
};

window.__firebaseConfigured = true;

// Inisialisasi Firebase (hanya sekali)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// Referensi ke Realtime Database
const db = firebase.database();
