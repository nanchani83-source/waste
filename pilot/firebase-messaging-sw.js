// FCM 백그라운드 알림 처리 (알림 표시·클릭 이동은 FCM이 payload의 webpush 설정대로 처리)
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("config.js");

firebase.initializeApp(globalThis.PILOT.FIREBASE);
firebase.messaging();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
