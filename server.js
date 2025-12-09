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
  const newOrder = { id: orderCounter++, items: items, status: '調理中', createdAt: new Date() };
  orders.push(newOrder);
  io.emit('new_kitchen_order', newOrder); 
  res.status(201).json({ message: 'OK', orderId: newOrder.id });
});

app.get('/api/order/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const order = orders.find(o => o.id === id);
  if (order) res.json(order); else res.status(404).json({ message: 'なし' });
});

// ★★★ 集計API (ここを修正) ★★★
app.get('/api/sales/today', (req, res) => {
    let totalRevenue = 0, totalItems = 0;
    // 今日の日付 (YYYY-MM-DD)
    const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');
    
    orders.forEach(order => {
        // 注文日
        const orderDate = new Date(order.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }).replaceAll('/', '-');

        // ★「提供済み」かつ「今日」の注文のみ集計
        if (order.status === '提供済み' && orderDate === today) {
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

  // 厨房「準備完了」
  socket.on('cooking_complete', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '調理中') {
      order.status = '支払い待ち'; 
      io.emit('status_updated', order);
      io.emit('new_pending_order', order);
      notifyCustomer(id);
    }
  });

  // レジ「支払い完了」
  socket.on('confirm_payment', ({ id }) => {
    const order = orders.find(o => o.id === id);
    if (order && order.status === '支払い待ち') {
      order.status = '提供済み';
      io.emit('status_updated', order);
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

  function notifyCustomer(orderId) {
    const targetSocketId = customerSockets[orderId];
    if (targetSocketId) io.to(targetSocketId).emit('order_ready');

    const subscription = subscriptions[orderId];
    if (subscription) {
      const payload = JSON.stringify({ title: '出来上がりました！', body: `注文番号: ${orderId} 番のお客様、レジまでお越しください。` });
      webpush.sendNotification(subscription, payload).catch(e => {});
    }
  }
});

const PORT = process.env.PORT || 3000; 
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
