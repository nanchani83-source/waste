// FCM 백그라운드 알림 처리 (알림 표시·클릭 이동은 FCM이 payload의 webpush 설정대로 처리)
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
importScripts("config.js");

firebase.initializeApp(globalThis.PILOT.FIREBASE);
firebase.messaging();

// 앱이 켜져 있을 때 duty.html이 직접 띄운 알림을 눌렀을 때: 당직 알림 화면을 열거나 이미 열린 창을 앞으로 가져온다.
// (FCM이 띄운 알림은 FCM이 payload의 링크로 열어 주므로 여기서는 건드리지 않는다)
self.addEventListener("notificationclick", (e) => {
  if (e.notification.data && e.notification.data.FCM_MSG) return;
  e.notification.close();
  const tag = e.notification.tag;
  const url = new URL("duty.html" + (tag && tag !== "test" && tag !== "fg" ? "?id=" + encodeURIComponent(tag) : ""), self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.indexOf("duty.html") > -1 && "focus" in c) {
        return (tag && tag !== "fg" && "navigate" in c ? c.navigate(url).catch(() => c) : Promise.resolve(c)).then((w) => (w || c).focus());
      }
    }
    return self.clients.openWindow(url);
  }));
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
