// 必要なライブラリ
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const path = require('path');
const webpush = require('web-push'); 

// Socket.IO CORS設定
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let orders = [];
let orderCounter = 1; 
let subscriptions = {};
let customerSockets = {};

// VAPIDキー
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:test@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  console.log("Web Push設定完了。");
} else {
  console.warn("VAPIDキー未設定。");
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
  if (!items || items.length === 0) { return res.status(400).json({ message: '注文内容が空です。' }); }
  const newOrder = { id: orderCounter++, items: items, status: '支払い待ち', createdAt: new Date() };
  orders.push(newOrder);
  io.emit('new_pending_order', newOrder); 
  res.status(201).json({ message: '注文を受け付けました。レジでお支払いください。', orderId: newOrder.id });
});

app.get('/api/order/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = orders.find(o => o.id === id);
  if (order) { res.json(order); } else { res.status(404).json({ message: '注文が見つかりません' }); }
});

app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0, totalItems = 0;
    const today = new Date();
    const todayString = today.toISOString().split('T')[0];
    orders.forEach(order => {
        if (order.status !== '支払い待ち' && order.createdAt.toISOString().split('T')[0] === todayString) {
            order.items.forEach(item => {
                totalRevenue += item.price * item.quantity;
                totalItems += item.quantity;
            });
        }
    });
    res.json({ totalRevenue, totalItems, date: todayString });
});

app.post('/api/subscribe', (req, res) => {
  const { subscription, orderId } = req.body;
  if (!subscription || !orderId) { return res.status(400).json({ error: '購読情報または注文IDがありません。' }); }
  subscriptions[orderId] = subscription;
  res.status(201).json({ message: '購読成功' });
});

// --- Socket.IO ---
io.on('connection', (socket) => {
  console.log('クライアント接続:', socket.id);
  socket.emit('initial_orders', orders);

  socket.on('confirm_payment', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '支払い待ち') {
      order.status = '受付済';
      io.emit('new_kitchen_order', order); 
      const targetSocketId = customerSockets[id];
      if (targetSocketId) { io.to(targetSocketId).emit('payment_confirmed', order); }
    }
  });
  
  socket.on('update_status', ({ id, status }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status !== '提供可能' && order.status !== '提供済み') { 
      order.status = status;
      io.emit('status_updated', order);
    }
  });

  socket.on('cooking_complete', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '調理中') {
      order.status = '提供可能';
      io.emit('order_is_ready', order);
    }
  });

  socket.on('register_customer', ({ orderId }) => {
    if (orderId) customerSockets[orderId] = socket.id;
  });

  socket.on('call_customer', ({ id }) => {
    console.log(`レジから呼び出し: 注文番号 ${id}`);
    const order = orders.find(o => o.id === id);
    
    // ★ ステータスを「提供済み」に変更
    if (order && order.status === '提供可能') {
        order.status = '提供済み';
        // ★ ここで更新を通知することが重要
        io.emit('status_updated', order); 
    }

    const targetSocketId = customerSockets[id];
    if (targetSocketId) io.to(targetSocketId).emit('order_ready');

    const subscription = subscriptions[id];
    if (subscription) {
      const payload = JSON.stringify({ title: 'ご注文の準備ができました！', body: `注文番号: ${id} 番のお客様、カウンターまでお越しください。` });
      webpush.sendNotification(subscription, payload)
        .then(() => { delete subscriptions[id]; delete customerSockets[id]; })
        .catch(err => { if (err.statusCode === 410 || err.statusCode === 404) delete subscriptions[id]; });
    }
  });
  
  socket.on('disconnect', () => {
    for (const orderId in customerSockets) { if (customerSockets[orderId] === socket.id) delete customerSockets[orderId]; }
  });
});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => console.log(`サーバー起動: http://localhost:${PORT}`));
