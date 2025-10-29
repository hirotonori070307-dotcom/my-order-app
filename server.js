// 必要なライブラリを読み込む
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const path = require('path');
const webpush = require('web-push'); 

// Socket.IOのCORS設定
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

let orders = [];
let orderCounter = 1; 
let subscriptions = {};
let customerSockets = {};

// VAPIDキーの設定
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("VAPIDキーが設定されていません。");
} else {
  webpush.setVapidDetails(
    'mailto:test@example.com', 
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log("Web Push設定完了。");
}

app.use(express.json());
app.use(express.static(path.join(__dirname))); 

// --- ルーティング ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'order.html')); });
app.get('/cashier', (req, res) => { res.sendFile(path.join(__dirname, 'cashier.html')); });
app.get('/kitchen', (req, res) => { res.sendFile(path.join(__dirname, 'kitchen.html')); });

// --- API ---
// [POST] /api/order (変更なし)
app.post('/api/order', (req, res) => {
  const items = req.body.items;
  if (!items || items.length === 0) {
    return res.status(400).json({ message: '注文内容が空です。' });
  }
  const newOrder = {
    id: orderCounter++, items: items, status: '支払い待ち', createdAt: new Date()
  };
  orders.push(newOrder);
  console.log('支払い待ち注文:', newOrder);
  io.emit('new_pending_order', newOrder); 
  res.status(201).json({ 
    message: '注文を受け付けました。レジでお支払いください。', 
    orderId: newOrder.id 
  });
});

// [GET] /api/sales/today (変更なし)
app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0, totalItems = 0;
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

// [POST] /api/subscribe (変更なし)
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


// --- リアルタイム通信 (Socket.IO) ---
io.on('connection', (socket) => {
  console.log('クライアントが接続しました:', socket.id);
  socket.emit('initial_orders', orders);

  // ★★★ レジからの「支払い完了」 (修正) ★★★
  socket.on('confirm_payment', (data) => {
    const orderId = data.id;
    const order = orders.find(o => o.id === orderId);
    if (order && order.status === '支払い待ち') {
      order.status = '受付済';
      
      // 1. 管理画面（厨房・レジ）に通知
      io.emit('new_kitchen_order', order);
      
      // 2. ★ [NEW] 特定のお客様に「支払い完了」（レシート情報）を通知 ★
      const targetSocketId = customerSockets[orderId];
      if (targetSocketId) {
        io.to(targetSocketId).emit('payment_confirmed', order); // レシート情報を送信
        console.log(`お客様 ${orderId} へ支払い完了通知を送信`);
      }
    }
  });
  
  // [NEW] 厨房・レジからの「ステータス更新」 (変更なし)
  socket.on('update_status', (data) => {
    const order = orders.find(o => o.id === data.id);
    if (order) {
      order.status = data.status;
      console.log(`ステータス更新: ${data.id} -> ${data.status}`);
      io.emit('status_updated', { id: data.id, status: data.status });
    }
  });

  // [NEW] 厨房からの「提供可能」通知 (変更なし)
  socket.on('order_ready_for_pickup', (data) => {
    const order = orders.find(o => o.id === data.id);
    if (order) {
      order.status = '提供可能';
      console.log(`提供可能: ${data.id}`);
      io.emit('order_is_ready', { id: data.id, status: '提供可能' });
    }
  });

  // お客様画面からの「注文番号登録」 (変更なし)
  socket.on('register_customer', (data) => {
    if (data.orderId) {
      customerSockets[data.orderId] = socket.id;
      console.log(`お客様登録 (Socket): 注文番号 ${data.orderId}`);
    }
  });

  // レジ画面からの「呼び出し」 (変更なし)
  socket.on('call_customer', (data) => {
    const orderId = data.id;
    console.log(`レジから呼び出し: 注文番号 ${orderId}`);
    
    const targetSocketId = customerSockets[orderId];
    if (targetSocketId) {
      io.to(targetSocketId).emit('order_ready');
    }

    const subscription = subscriptions[orderId];
    if (subscription) {
      const payload = JSON.stringify({
        title: 'ご注文の準備ができました！',
        body: `注文番号: ${orderId} 番のお客様、カウンターまでお越しください。`,
      });
      webpush.sendNotification(subscription, payload)
        .then(() => {
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
  
  // 接続が切れた時の処理 (変更なし)
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

// --- サーバー起動 --- (変更なし)
const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => {
  console.log(`サーバーが http://localhost:${PORT} で起動しました。`);
});
