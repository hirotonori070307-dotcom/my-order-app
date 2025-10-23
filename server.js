// 必要なライブラリを読み込む
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const path = require('path');
const webpush = require('web-push'); // ★ 追加

let orders = [];
let orderCounter = 1; 

// ★ お客様の「通知許可情報」を保存する場所 (本来はDB)
// { orderId: subscription }
let subscriptions = {};

// ★ お客様の「Socket接続情報」を保存する場所 (アプリを開いている人用)
// { orderId: socketId }
let customerSockets = {};

// ★ VAPIDキーの設定 (Renderの環境変数から読み込むようにする)
// ※ || の右側は、ローカルで試す場合に貼り付けます (デプロイ時は消してもOK)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'ここに先ほど生成したPublic Keyを貼り付け';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'ここに先ほど生成したPrivate Keyを貼り付け';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || VAPID_PUBLIC_KEY === 'ここに先ほど生成したPublic Keyを貼り付け') {
  console.warn("VAPIDキーが設定されていません。プッシュ通知は動作しません。");
} else {
  webpush.setVapidDetails(
    'mailto:test@example.com', // 連絡先メールアドレス (ダミーでも可)
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log("Web Push設定完了。");
}

app.use(express.json());

// --- 静的ファイルの配信 ---
// ★ service-worker.js なども配信できるように変更
app.use(express.static(path.join(__dirname))); 

// ★ 各画面へのルーティング
// (express.staticにより order.html は自動的に '/' で配信される)
app.get('/cashier', (req, res) => {
  res.sendFile(path.join(__dirname, 'cashier.html'));
});

app.get('/kitchen', (req, res) => {
  res.sendFile(path.join(__dirname, 'kitchen.html'));
});

// [POST] /api/order : 支払い待ち注文の受付 (変更なし)
app.post('/api/order', (req, res) => {
  const items = req.body.items;
  if (!items || items.length === 0) {
    return res.status(400).json({ message: '注文内容が空です。' });
  }
  const newOrder = {
    id: orderCounter++,
    items: items,
    status: '支払い待ち', 
    createdAt: new Date()
  };
  orders.push(newOrder);
  console.log('支払い待ち注文:', newOrder);
  io.emit('new_pending_order', newOrder); 
  res.status(201).json({ 
    message: '注文を受け付けました。レジでお支払いください。', 
    orderId: newOrder.id 
  });
});

// [GET] /api/sales/today : 売上集計API (変更なし)
app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0;
    let totalItems = 0;
    const today = new Date();
    const todayString = today.getFullYear() + '-' + (today.getMonth() + 1).toString().padStart(2, '0') + '-' + today.getDate().toString().padStart(2, '0');
    orders.forEach(order => {
        if (order.status !== '支払い待ち') {
            const orderDate = order.createdAt;
            const orderDateString = orderDate.getFullYear() + '-' + (orderDate.getMonth() + 1).toString().padStart(2, '0') + '-' + orderDate.getDate().toString().padStart(2, '0');
            if (orderDateString === todayString) {
                order.items.forEach(item => {
                    totalRevenue += item.price * item.quantity;
                    totalItems += item.quantity;
                });
            }
        }
    });
    res.json({ totalRevenue, totalItems, date: todayString });
});

// ★★★ [POST] /api/subscribe : プッシュ通知の購読情報を登録 ★★★
app.post('/api/subscribe', (req, res) => {
  const subscription = req.body.subscription;
  const orderId = req.body.orderId;

  if (!subscription || !orderId) {
    return res.status(400).json({ error: '購読情報または注文IDがありません。' });
  }
  subscriptions[orderId] = subscription;
  console.log(`注文 ${orderId} のプッシュ購読を登録しました。`);
  res.status(201).json({ message: '購読成功' });
});


// --- リアルタイム通信 (Socket.IO) の設定 ---
io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);
  socket.emit('initial_orders', orders);

  // レジからの「支払い完了」通知 (変更なし)
  socket.on('confirm_payment', (data) => {
    const orderId = data.id;
    const order = orders.find(o => o.id === orderId);
    if (order && order.status === '支払い待ち') {
      order.status = '受付済';
      io.emit('new_kitchen_order', order);
    }
  });

  // お客様画面からの「注文番号登録」(アプリ開いている人用)
  socket.on('register_customer', (data) => {
    const orderId = data.orderId;
    if (orderId) {
      customerSockets[orderId] = socket.id;
      console.log(`お客様登録 (Socket): 注文番号 ${orderId}`);
    }
  });

  // ★★★ 厨房画面からの「呼び出し」通知 (プッシュ通知機能を追加) ★★★
  socket.on('call_customer', (data) => {
    const orderId = data.id;
    console.log(`厨房から呼び出し: 注文番号 ${orderId}`);
    
    // 1. (フォアグラウンド通知) アプリを開いている人にSocket.IOで通知
    const targetSocketId = customerSockets[orderId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('order_ready');
      console.log(`お客様 ${orderId} へSocket通知送信`);
    }

    // 2. (バックグラウンド通知) プッシュ通知の購読情報を探す
    const subscription = subscriptions[orderId];
    if (subscription) {
      const payload = JSON.stringify({
        title: 'ご注文の準備ができました！',
        body: `注文番号: ${orderId} 番のお客様、カウンターまでお越しください。`,
      });

      console.log(`お客様 ${orderId} へプッシュ通知送信`);
      webpush.sendNotification(subscription, payload)
        .then(() => {
          // 呼び出しが成功したら、保存データを削除（再呼び出し防止）
          delete subscriptions[orderId];
          delete customerSockets[orderId];
        })
        .catch(err => {
          console.error(`注文 ${orderId} へのプッシュ通知失敗:`, err.statusCode);
          if (err.statusCode === 410 || err.statusCode === 404) {
            delete subscriptions[orderId];
          }
        });
    }
  });
  
  // 接続が切れた時の処理
  socket.on('disconnect', () => {
    console.log('クライアントが切断しました:', socket.id);
    for (const orderId in customerSockets) {
      if (customerSockets[orderId] === socket.id) {
        delete customerSockets[orderId];
        console.log(`お客様登録解除 (Socket): 注文番号 ${orderId}`);
        break;
      }
    }
  });
});


// --- サーバー起動 ---
// ★ Render用にポート設定を変更
const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で起動しました。`);
});