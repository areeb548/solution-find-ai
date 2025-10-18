import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuid } from 'uuid';
import { usersDb, questionsDb } from './lib/database.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const allowedImageTypes = new Set(['image/jpeg', 'image/png']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await fs.mkdir(path.join(__dirname, 'uploads'), { recursive: true });
await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, callback) => {
    if (allowedImageTypes.has(file.mimetype)) {
      callback(null, true);
    } else {
      callback(new Error('Unsupported file type. Only PNG and JPEG are allowed.'));
    }
  },
});

const geminiApiKey = process.env.GEMINI_API_KEY;
const geminiModelName = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const geminiClient = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

const sendAuthCookie = (res, token) => {
  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
};

const authMiddleware = async (req, res, next) => {
  const token = req.cookies?.token;
  if (!token) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await usersDb.findOne({ _id: payload.id });
    if (!user) {
      res.status(401).json({ message: 'Unauthorized' });
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Unauthorized' });
  }
};

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ message: 'Name, email, and password are required.' });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await usersDb.findOne({ email: normalizedEmail });
    if (existing) {
      res.status(409).json({ message: 'Email is already registered.' });
      return;
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await usersDb.insert({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      createdAt: new Date(),
    });
    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    sendAuthCookie(res, token);
    res.json({ id: user._id, name: user.name, email: user.email });
  } catch (error) {
    res.status(500).json({ message: 'Failed to sign up.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ message: 'Email and password are required.' });
      return;
    }
    const normalizedEmail = email.trim().toLowerCase();
    const user = await usersDb.findOne({ email: normalizedEmail });
    if (!user) {
      res.status(401).json({ message: 'Invalid credentials.' });
      return;
    }
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      res.status(401).json({ message: 'Invalid credentials.' });
      return;
    }
    const token = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    sendAuthCookie(res, token);
    res.json({ id: user._id, name: user.name, email: user.email });
  } catch (error) {
    res.status(500).json({ message: 'Failed to log in.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ id: req.user._id, name: req.user.name, email: req.user.email });
});

app.post('/api/questions', authMiddleware, upload.single('image'), async (req, res) => {
  try {
    const { subject, question } = req.body;
    if (!subject || !question) {
      res.status(400).json({ message: 'Subject and question are required.' });
      return;
    }
    if (!geminiClient) {
      res.status(500).json({ message: 'Gemini API key is not configured.' });
      return;
    }
    const prompt = `You are an award-winning copywriter and subject-matter expert. Respond in at most two sentences.
Sentence 1: deliver the precise answer to the user's request (include any required calculations or figures).
Sentence 2 (optional): share a brief persuasive insight or benefit related to that answer.
Do not add extra fluff or unrelated content.
Subject: ${subject}
Prompt: ${question}`;
    const model = geminiClient.getGenerativeModel({ model: geminiModelName });
    const parts = [{ text: prompt }];
    let imagePath = null;

    if (req.file) {
      const absolutePath = path.join(__dirname, req.file.path || `uploads/${req.file.filename}`);
      const imageData = await fs.readFile(absolutePath);
      parts.push({
        inlineData: {
          data: imageData.toString('base64'),
          mimeType: req.file.mimetype,
        },
      });
      imagePath = `/uploads/${req.file.filename}`;
    }

    const completion = await model.generateContent(parts);
    const answer = completion.response?.text()?.trim() || 'No answer generated.';
    const entry = await questionsDb.insert({
      _id: uuid(),
      userId: req.user._id,
      subject,
      question,
      answer,
      imagePath,
      createdAt: new Date(),
    });
    res.json({
      id: entry._id,
      subject: entry.subject,
      question: entry.question,
      answer: entry.answer,
      imagePath: entry.imagePath,
      createdAt: entry.createdAt,
    });
  } catch (error) {
    console.error('Gemini request failed:', error.message, error);
    if (req.file) {
      await fs.rm(path.join(__dirname, req.file.path), { force: true });
    }
    const details = error.message || 'Unknown error.';
    res.status(500).json({ message: 'Failed to generate answer.', details });
  }
});

app.get('/api/questions', authMiddleware, async (req, res) => {
  try {
    const records = await questionsDb.cfind({ userId: req.user._id }).sort({ createdAt: -1 }).exec();
    res.json(records.map((entry) => ({
      id: entry._id,
      subject: entry.subject,
      question: entry.question,
      answer: entry.answer,
      imagePath: entry.imagePath,
      createdAt: entry.createdAt,
    })));
  } catch (error) {
    res.status(500).json({ message: 'Failed to load questions.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message?.includes('Unsupported file type')) {
    res.status(400).json({ message: err.message });
  } else {
    res.status(500).json({ message: 'An unexpected error occurred.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
