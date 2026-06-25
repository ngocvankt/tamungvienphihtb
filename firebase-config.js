// Cấu hình Firebase Realtime Database cho phần mềm quản lý tạm ứng viện phí.
// Dùng Firebase compat SDK để phù hợp với code HTML/JS thuần hiện tại.
const firebaseConfig = {
  apiKey: "AIzaSyDqy_iYSpwCRgk1szcFC9HCUkaOXAtaJ3Y",
  authDomain: "tamungvienphihtb-6a3fc.firebaseapp.com",
  databaseURL: "https://tamungvienphihtb-6a3fc-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "tamungvienphihtb-6a3fc",
  storageBucket: "tamungvienphihtb-6a3fc.firebasestorage.app",
  messagingSenderId: "1081962762123",
  appId: "1:1081962762123:web:69b0dcd212fedadd65298e",
  measurementId: "G-HJGKJCN5GW"
};

if (typeof firebase !== 'undefined') {
  firebase.initializeApp(firebaseConfig);
  window.firebaseDb = firebase.database();
  window.FIREBASE_ENABLED = true;
} else {
  window.FIREBASE_ENABLED = false;
  console.warn('Firebase SDK chưa tải được. Phần mềm sẽ chạy bằng dữ liệu localStorage.');
}
