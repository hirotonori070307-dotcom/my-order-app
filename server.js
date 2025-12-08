const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const path = require('path');
const webpush = require('web-push'); 

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let orders = [];
let orderCounter = 1; 
let subscriptions = {};
let customerSockets = {};

// VAPIDキー (環境変数から読み込み)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

app.use(express.json());
app.use(express.static(path.join(__dirname))); 

// --- ルーティング ---
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'order.html')); });
app.get('/cashier', (req, res) => { res.sendFile(path.join(__dirname, 'cashier.html')); });
app.get('/kitchen', (req, res) => { res.sendFile(path.join(__dirname, 'kitchen.html')); });

// --- API ---
app.post('/api/order', (req, res) => {
  const items = req.body.items;
  if (!items || items.length === 0) { return res.status(400).json({ message: '空です' }); }
  
  // ★ 初期ステータスを「調理中」に変更（レジにはまだ表示しない）
  const newOrder = { id: orderCounter++, items: items, status: '調理中', createdAt: new Date() };
  orders.push(newOrder);
  
  // 厨房に通知
  io.emit('new_kitchen_order', newOrder); 
  res.status(201).json({ message: '注文を受け付けました。', orderId: newOrder.id });
});

app.get('/api/order/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = orders.find(o => o.id === id);
  if (order) res.json(order); else res.status(404).json({ message: 'なし' });
});

app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0, totalItems = 0;
    const today = new Date().toISOString().split('T')[0];
    orders.forEach(order => {
        // 提供済み（支払い済み）のみ集計
        if (order.status === '提供済み' && order.createdAt.toISOString().split('T')[0] === today) {
            order.items.forEach(item => {
                totalRevenue += item.price * item.quantity;
                totalItems += item.quantity;
            });
        }
    });
    res.json({ totalRevenue, totalItems, date: today });
});

app.post('/api/subscribe', (req, res) => {
  const { subscription, orderId } = req.body;
  if (subscription && orderId) subscriptions[orderId] = subscription;
  res.status(201).json({ message: 'OK' });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  socket.emit('initial_orders', orders);

  // ★ 厨房からの「準備完了」
  // -> レジに表示(支払い待ち) ＆ お客さんに通知
  socket.on('cooking_complete', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '調理中') {
      order.status = '支払い待ち'; 
      console.log(`準備完了(支払い待ちへ): ${id}`);
      
      // 全画面へ更新通知（レジに表示されるようになる）
      io.emit('status_updated', order);
      // レジ画面に「新規支払い待ち」として通知
      io.emit('new_pending_order', order);

      // ★ お客さんへ呼び出し通知
      notifyCustomer(id);
    }
  });

  // ★ レジからの「支払い完了」
  // -> 提供済みへ ＆ レシート表示
  socket.on('confirm_payment', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '支払い待ち') {
      order.status = '提供済み';
      console.log(`支払い完了(提供済みへ): ${id}`);
      
      io.emit('status_updated', order);
      
      // お客さんへレシート通知
      const targetSocketId = customerSockets[id];
      if (targetSocketId) io.to(targetSocketId).emit('payment_confirmed', order);
    }
  });

  socket.on('register_customer', ({ orderId }) => {
    if (orderId) customerSockets[orderId] = socket.id;
  });
  
  socket.on('disconnect', () => {
    for (const oid in customerSockets) { if (customerSockets[oid] === socket.id) delete customerSockets[oid]; }
  });

  // お客様への通知処理（共通化）
  function notifyCustomer(orderId) {
    const targetSocketId = customerSockets[orderId];
    if (targetSocketId) io.to(targetSocketId).emit('order_ready');

    const subscription = subscriptions[orderId];
    if (subscription) {
      const payload = JSON.stringify({ title: '出来上がりました！', body: `注文番号: ${orderId} 番のお客様、レジまでお越しください。` });
      webpush.sendNotification(subscription, payload)
        .catch(err => { if (err.statusCode === 410 || err.statusCode === 404) delete subscriptions[orderId]; });
    }
  }
});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
