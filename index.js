// 날마다 QT 알림 보내기 (GitHub Actions가 5분마다 실행)
// - 꾹 찌르기: 아직 알리지 않은 오늘의 꾹을 받는 사람 휴대폰으로 보내요.
// - 매일 알림: 정한 시각이 지났고(2시간 안), 오늘 아직 묵상을 안 했고, 오늘 아직 안 보냈으면 보내요.
// - TEST_EMAIL이 있으면 그 사람에게 테스트 알림만 보내요.
const admin = require("firebase-admin");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();

const APP_URL = "https://nalmada-qt.firebaseapp.com/";
const WINDOW_MIN = 120; // 정한 시각에서 이만큼 지나면 그날 알림은 건너뛰어요
const DEAD = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);
const pad = n => String(n).padStart(2, "0");

function seoulNow() {
  const k = new Date(Date.now() + 9 * 3600 * 1000); // Asia/Seoul, no DST
  return {
    date: `${k.getUTCFullYear()}-${pad(k.getUTCMonth() + 1)}-${pad(k.getUTCDate())}`,
    minutes: k.getUTCHours() * 60 + k.getUTCMinutes(),
  };
}

async function sendTo(uid, title, body) {
  const ref = db.doc(`push/${uid}`);
  const snap = await ref.get();
  const tokens = (snap.exists && snap.get("tokens")) || [];
  if (!tokens.length) return 0;
  const res = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: {
      notification: { icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" },
      fcmOptions: { link: APP_URL },
    },
  });
  const dead = tokens.filter((_, i) => !res.responses[i].success && DEAD.has(res.responses[i].error?.code));
  if (dead.length) await ref.update({ tokens: admin.firestore.FieldValue.arrayRemove(...dead) });
  return res.successCount;
}

async function sendPokes(today) {
  const qs = await db.collection("pokes").where("notified", "==", false).get();
  let sent = 0;
  for (const d of qs.docs) {
    const p = d.data();
    if (p.date === today) {
      const from = await db.doc(`members/${p.from}`).get();
      const name = (from.exists && from.get("name")) || "친구";
      sent += await sendTo(p.to, "꾹! 날마다 QT", `${name}님이 꾹 찔렀어요. 오늘 묵상하러 가요!`);
    }
    await d.ref.update({ notified: true });
  }
  return sent;
}

async function sendReminders(today, minutes) {
  const qs = await db.collection("push").where("remindOn", "==", true).get();
  let sent = 0;
  for (const d of qs.docs) {
    const [h, m] = String(d.get("remindTime") || "07:00").split(":").map(Number);
    const due = h * 60 + m;
    if (minutes < due || minutes > due + WINDOW_MIN) continue;
    if (d.get("lastRemind") === today) continue;
    const member = await db.doc(`members/${d.id}`).get();
    if (!(member.exists && member.get("lastDate") === today)) {
      sent += await sendTo(d.id, "날마다 QT", "묵상할 시간이에요. 오늘의 리딩지저스와 말씀을 함께 읽어요.");
    }
    await d.ref.update({ lastRemind: today });
  }
  return sent;
}

async function main() {
  const testEmail = (process.env.TEST_EMAIL || "").trim();
  if (testEmail) {
    const user = await admin.auth().getUserByEmail(testEmail);
    const n = await sendTo(user.uid, "날마다 QT", "테스트 알림이에요. 알림이 잘 오고 있어요!");
    console.log(n ? `테스트 알림을 기기 ${n}대에 보냈어요.` : "이 계정에 알림이 켜진 기기가 없어요. 앱 설정에서 '이 기기에서 알림 받기'를 먼저 눌러 주세요.");
    return;
  }
  const { date, minutes } = seoulNow();
  const pokes = await sendPokes(date);
  const reminders = await sendReminders(date, minutes);
  console.log(`${date} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)} KST · 꾹 알림 ${pokes}건 · 매일 알림 ${reminders}건`);
}

main().catch(e => { console.error(e); process.exit(1); });
