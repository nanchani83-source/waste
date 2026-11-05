// 시범운영 설정 — 공개되어도 되는 값만 넣을 것 (서비스계정 키·등록코드는 절대 넣지 않음)
// Apps Script 배포 후, Firebase 웹앱 등록 후 아래 빈 값을 채운다.
globalThis.PILOT = {
  API_URL: "https://script.google.com/macros/s/AKfycbwCiS_IGqeR6MAjisIPcic0eirtIfUdIb9flslCCe-Ki_ZEdVy-ig1mvAN74Zb18f8/exec",            // Apps Script 웹앱 URL (…/exec)
  VAPID: "BDZBibsP_Gf9CqRSCRXOlNodAcH-qQnoWFLuH4LCSYgWWFzizKB5_nsg2tOBAiaN3rB7nwC9fCf7pkUNsawIj94",              // Firebase 콘솔 > 프로젝트 설정 > 클라우드 메시징 > 웹 푸시 인증서 공개키
  FIREBASE: {
    apiKey: "AIzaSyBHqcStMRRp4bDDPvpctKTANux2EocFDqo",
    authDomain: "knuh-clean-pilot.firebaseapp.com",
    projectId: "knuh-clean-pilot",
    messagingSenderId: "224790555880",
    appId: "1:224790555880:web:fad284458f66efe475ed5d"
  }
};
