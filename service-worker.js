// service-worker.js

// プッシュ通知イベントを待ち受ける
self.addEventListener('push', function(event) {
  console.log('プッシュ通知を受信しました。', event);

  let data = { title: 'ご注文のお知らせ', body: '準備ができました。' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const title = data.title;
  const options = {
    body: data.body,
    icon: '/icon.png', // (オプション: icon.pngをZ:\saverに用意)
    badge: '/badge.png', // (オプション: badge.pngをZ:\saverに用意)
    vibrate: [200, 100, 200, 100, 200] // バイブレーション
  };

  // 通知を表示する
  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// 通知をクリックしたときの動作
self.addEventListener('notificationclick', function(event) {
  event.notification.close(); // 通知を閉じる
  
  // クリックしたらアプリのページを開く
  event.waitUntil(
    clients.openWindow('/') 
  );
});