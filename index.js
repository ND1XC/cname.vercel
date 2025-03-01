require("dotenv").config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bodyParser = require('body-parser');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const { spawn, execSync, exec } = require('child_process');
const Discord = require("discord.js");
const app = express();
const PORT = process.env.PORT;

// دالة للبحث عن الملف الرئيسي
async function findMainFile(serverPath) {
    const mainFileNames = ['index.js', 'bot.js', 'main.js', 'server.js'];
    
    for (const fileName of mainFileNames) {
        const filePath = path.join(serverPath, fileName);
        if (await fs.pathExists(filePath)) {
            return filePath;
        }
    }
    return null;
}

// Map للعمليات والإحصائيات
const processes = new Map();
const serverStats = new Map();
const clients = new Map(); // إضافة هذا السطر

// تكوين Discord Bot
const client = new Discord.Client({intents: 3276799});
client.login(process.env.token);

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// تكوين MongoDB
mongoose.connect(process.env.mongodb, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    retryWrites: true,
    w: 'majority'
}).then(() => {
    console.log('✅ Connected to MongoDB');
}).catch(err => {
    console.error('❌ MongoDB connection error:', err);
    process.exit(1);
});

// تكوين Passport
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.clientId,
    clientSecret: process.env.client_secret,
    callbackURL: process.env.callbackURL,
    scope: ['identify', 'guilds']
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

// تكوين Multer مع دعم سحب وإفلات الملفات
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!req.user) {
            return cb(new Error('User not authenticated'));
        }
        const userId = req.user.id;
        const uploadPath = path.join(__dirname, 'uploads', userId);
        fs.ensureDirSync(uploadPath);
        cb(null, uploadPath);
    },
    filename: function (req, file, cb) {
        const originalname = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `${Date.now()}-${originalname}`);
    }
});

const upload = multer({ 
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'application/zip' || 
            file.mimetype === 'application/x-zip-compressed' ||
            file.originalname.toLowerCase().endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('يُسمح فقط بملفات ZIP'));
        }
    },
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// إعدادات Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// إعدادات الجلسة
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ 
        mongoUrl: process.env.mongodb,
        ttl: 24 * 60 * 60
    }),
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// تهيئة Passport
app.use(passport.initialize());
app.use(passport.session());

// المسارات الرئيسية بعد تهيئة Passport
app.get('/', (req, res) => {
    res.render('home', { 
        error: req.query.error,
        message: req.query.message,
        isAuthenticated: req.isAuthenticated(),
        user: req.user
    });
});

app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

// تعريف نموذج MongoDB للمستخدمين (نقله إلى أعلى الملف بعد اتصال MongoDB مباشرة)
const UserServerCount = mongoose.model('UserServerCount', new mongoose.Schema({
    userId: String,
    count: { type: Number, default: 0 }
}), 'userservercounts');

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }

    const userId = req.user.id;
    const uploadPath = path.join(__dirname, 'uploads', userId);
    let servers = [];

    if (await fs.pathExists(uploadPath)) {
        const items = await fs.readdir(uploadPath);
        servers = items.filter(item => 
            fs.statSync(path.join(uploadPath, item)).isDirectory()
        );
    }

    // استخدام النموذج المعرف مسبقاً
    const userCount = await UserServerCount.findOne({ userId });
    res.render('index', { 
        user: req.user, 
        servers: servers,
        userServerCount: userCount ? userCount.count : 0
    });
});

app.get('/server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }

    try {
        const { serverName } = req.params;
        const userId = req.user.id;
        // تأكد من فك ترميز اسم السيرفر
        const decodedServerName = decodeURIComponent(serverName);
        const serverPath = path.join(__dirname, 'uploads', userId, decodedServerName);

        if (!await fs.pathExists(serverPath)) {
            return res.redirect('/dashboard?error=Server not found');
        }

        const processKey = `${userId}-${decodedServerName}`;
        const isRunning = processes.has(processKey);

        res.render('server-control', {
            user: req.user,
            serverName: decodedServerName,
            isRunning: isRunning
        });
    } catch (error) {
        console.error('Server control error:', error);
        res.redirect('/dashboard?error=' + encodeURIComponent('Error accessing server'));
    }
});

app.get('/create-server', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }
    res.render('create-server', { 
        user: req.user,
        error: null
    });
});

app.get('/edit-server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }

    try {
        const { serverName } = req.params;
        const userId = req.user.id;
        const serverPath = path.join(__dirname, 'uploads', userId, serverName);

        if (!await fs.pathExists(serverPath)) {
            return res.redirect('/dashboard?error=Server not found');
        }

        const files = await fs.readdir(serverPath);
        const mainFile = await findMainFile(serverPath);
        const processKey = `${userId}-${serverName}`;
        const isRunning = processes.has(processKey);

        res.render('edit-server', {
            user: req.user,
            serverName: serverName,
            files: files,
            mainFile: mainFile ? path.basename(mainFile) : null,
            isRunning: isRunning
        });
    } catch (error) {
        res.redirect('/dashboard?error=' + encodeURIComponent(error.message));
    }
});

// إنشاء المجلدات المطلوبة
app.use(async (req, res, next) => {
    try {
        await fs.ensureDir(path.join(__dirname, 'views'));
        await fs.ensureDir(path.join(__dirname, 'uploads'));
        next();
    } catch (error) {
        console.error('Error creating directories:', error);
        next(error);
    }
});

// تشغيل الخادم
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// مسار API لإيقاف السيرفر/:serverName', async (req, res) => {
app.post('/api/stop-server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { serverName } = req.params;
        const userId = req.user.id;
        const processKey = `${userId}-${serverName}`;

        const processData = processes.get(processKey);
        if (processData) {
            processData.process.kill('SIGTERM');
            processes.delete(processKey);
            res.json({ success: true });
        } else {
            res.json({ success: false, error: 'Server is not running' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// مسار API لقراءة محتوى الملف
app.get('/api/file-content/:serverName/:fileName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { serverName, fileName } = req.params;
        const userId = req.user.id;
        const filePath = path.join(__dirname, 'uploads', userId, serverName, fileName);

        if (!await fs.pathExists(filePath)) {
            return res.status(404).send('File not found');
        }

        const content = await fs.readFile(filePath, 'utf8');
        res.send(content);
    } catch (error) {
        res.status(500).send(error.message);
    }
});

// مسار API لحفظ محتوى الملف
app.post('/api/save-file/:serverName/:fileName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { serverName, fileName } = req.params;
        const { content } = req.body;
        const userId = req.user.id;
        const filePath = path.join(__dirname, 'uploads', userId, serverName, fileName);

        await fs.writeFile(filePath, content, 'utf8');
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});
// إضافة مسار API لتشغيل السيرفر
app.post('/api/start-server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { serverName } = req.params;
        const userId = req.user.id;
        const serverPath = path.join(__dirname, 'uploads', userId, serverName);
        const mainFile = await findMainFile(serverPath);

        if (!mainFile) {
            return res.json({ success: false, error: 'Main file not found' });
        }

        const processKey = `${userId}-${serverName}`;
        if (processes.has(processKey)) {
            return res.json({ success: false, error: 'Server is already running' });
        }

        const process = spawn('node', [mainFile], {
            cwd: serverPath
        });

        processes.set(processKey, {
            process,
            output: [],
            startTime: Date.now()
        });

        process.stdout.on('data', (data) => {
            const output = data.toString();
            const processData = processes.get(processKey);
            if (processData) {
                processData.output.push(output);
            }
        });

        process.stderr.on('data', (data) => {
            const output = data.toString();
            const processData = processes.get(processKey);
            if (processData) {
                processData.output.push(output);
            }
        });

        process.on('close', (code) => {
            processes.delete(processKey);
        });

        res.json({ 
            success: true, 
            processKey,
            output: 'Server started successfully'
        });
    } catch (error) {
        console.error('Error starting server:', error);
        res.json({ success: false, error: error.message });
    }
});

// مسار لتدفق مخرجات السيرفر
app.get('/api/stream-output/:processKey', (req, res) => {
    const { processKey } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const processData = processes.get(processKey);
    if (processData) {
        const { output } = processData;
        if (output.length > 0) {
            res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
            output.length = 0;
        }
    }

    const interval = setInterval(() => {
        const processData = processes.get(processKey);
        if (processData) {
            const { output } = processData;
            if (output.length > 0) {
                res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
                output.length = 0;
            }
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
    });
});
// مسار حذف الملفات
app.post('/api/delete-server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
    }

    try {
        const serverName = decodeURIComponent(req.params.serverName);
        const userId = req.user.id;
        const serverPath = path.join(__dirname, 'uploads', userId, serverName);

        // التحقق من وجود السيرفر
        const exists = await fs.pathExists(serverPath);
        if (!exists) {
            return res.json({ success: false, error: 'السيرفر غير موجود' });
        }

        // إيقاف السيرفر إذا كان قيد التشغيل
        const processKey = `${userId}-${serverName}`;
        if (processes.has(processKey)) {
            const processData = processes.get(processKey);
            processData.process.kill('SIGTERM');
            processes.delete(processKey);
        }

        // حذف مجلد السيرفر
        await fs.remove(serverPath);

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting server:', error);
        res.json({ success: false, error: 'حدث خطأ أثناء حذف السيرفر' });
    }
});
// إضافة مسار API لتشغيل السيرفر
app.post('/api/start-server/:serverName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    try {
        const { serverName } = req.params;
        const userId = req.user.id;
        const serverPath = path.join(__dirname, 'uploads', userId, serverName);
        const mainFile = await findMainFile(serverPath);

        if (!mainFile) {
            return res.json({ success: false, error: 'Main file not found' });
        }

        const processKey = `${userId}-${serverName}`;
        if (processes.has(processKey)) {
            return res.json({ success: false, error: 'Server is already running' });
        }

        const process = spawn('node', [mainFile], {
            cwd: serverPath
        });

        processes.set(processKey, {
            process,
            output: [],
            startTime: Date.now()
        });

        process.stdout.on('data', (data) => {
            const output = data.toString();
            const processData = processes.get(processKey);
            if (processData) {
                processData.output.push(output);
            }
        });

        process.stderr.on('data', (data) => {
            const output = data.toString();
            const processData = processes.get(processKey);
            if (processData) {
                processData.output.push(output);
            }
        });

        process.on('close', (code) => {
            processes.delete(processKey);
        });

        res.json({ 
            success: true, 
            processKey,
            output: 'Server started successfully'
        });
    } catch (error) {
        console.error('Error starting server:', error);
        res.json({ success: false, error: error.message });
    }
});

// مسار لتدفق مخرجات السيرفر
app.get('/api/stream-output/:processKey', (req, res) => {
    const { processKey } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const processData = processes.get(processKey);
    if (processData) {
        const { output } = processData;
        if (output.length > 0) {
            res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
            output.length = 0;
        }
    }

    const interval = setInterval(() => {
        const processData = processes.get(processKey);
        if (processData) {
            const { output } = processData;
            if (output.length > 0) {
                res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
                output.length = 0;
            }
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
    });
});
// مسار حذف الملفات
app.delete('/delete-file/:serverName/:fileName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
    }

    try {
        const { serverName, fileName } = req.params;
        const userId = req.user.id;
        const filePath = path.join(__dirname, 'uploads', userId, serverName, fileName);

        // التحقق من وجود الملف
        if (!await fs.pathExists(filePath)) {
            return res.json({ success: false, error: 'الملف غير موجود' });
        }

        // حذف الملف
        await fs.remove(filePath);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.json({ success: false, error: error.message });
    }
});
// مسار إنشاء سيرفر جديد
app.post('/create-server', upload.single('serverFile'), async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/');
    }

    try {
        const { serverName } = req.body;
        const userId = req.user.id;
        
        // التحقق من اسم السيرفر
        if (!serverName || !/^[\u0600-\u06FFa-zA-Z0-9-_]+$/.test(serverName)) {
            if (req.file) await fs.unlink(req.file.path).catch(console.error);
            return res.render('create-server', {
                user: req.user,
                error: 'اسم السيرفر غير صالح. يمكن استخدام الحروف العربية والإنجليزية والأرقام والشرطات فقط'
            });
        }

        // التحقق من الملف
        if (!req.file) {
            return res.render('create-server', {
                user: req.user,
                error: 'الرجاء اختيار ملف ZIP'
            });
        }

        const serverPath = path.join(__dirname, 'uploads', userId, serverName);

        // التحقق من وجود السيرفر مسبقاً
        if (await fs.pathExists(serverPath)) {
            await fs.unlink(req.file.path);
            return res.render('create-server', {
                user: req.user,
                error: 'يوجد سيرفر بهذا الاسم مسبقاً'
            });
        }

        // إنشاء مجلد السيرفر وفك ضغط الملف
        await fs.ensureDir(serverPath);
        const extract = require('extract-zip');
        await extract(req.file.path, { dir: serverPath });
        await fs.unlink(req.file.path);

        // تحديث عدد السيرفرات
        await UserServerCount.findOneAndUpdate(
            { userId: userId },
            { $inc: { count: 1 } },
            { upsert: true }
        );

        res.redirect('/dashboard');
    } catch (error) {
        console.error('Error creating server:', error);
        if (req.file) {
            await fs.unlink(req.file.path).catch(console.error);
        }
        res.render('create-server', {
            user: req.user,
            error: 'حدث خطأ أثناء إنشاء السيرفر: ' + error.message
        });
    }
});

// مسار لتدفق مخرجات السيرفر
app.get('/api/stream-output/:processKey', (req, res) => {
    const { processKey } = req.params;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const processData = processes.get(processKey);
    if (processData) {
        const { output } = processData;
        if (output.length > 0) {
            res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
            output.length = 0;
        }
    }

    const interval = setInterval(() => {
        const processData = processes.get(processKey);
        if (processData) {
            const { output } = processData;
            if (output.length > 0) {
                res.write(`data: ${JSON.stringify(output.join('\n'))}\n\n`);
                output.length = 0;
            }
        }
    }, 1000);

    req.on('close', () => {
        clearInterval(interval);
    });
});
// مسار حذف الملفات
app.delete('/delete-file/:serverName/:fileName', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'غير مصرح' });
    }

    try {
        const { serverName, fileName } = req.params;
        const userId = req.user.id;
        const filePath = path.join(__dirname, 'uploads', userId, serverName, fileName);

        // التحقق من وجود الملف
        if (!await fs.pathExists(filePath)) {
            return res.json({ success: false, error: 'الملف غير موجود' });
        }

        // حذف الملف
        await fs.remove(filePath);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting file:', error);
        res.json({ success: false, error: error.message });
    }
});