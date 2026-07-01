import express from "express";
import path from "path";
import fs from "fs";
import nodemailer from "nodemailer";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

export const app = express();
const PORT = 3000;
const DB_FILE = path.join(process.cwd(), "db.json");

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

// Initialize Firebase on Server using JS/Web SDK (portable across client and custom backends)
const firebaseConfigPath = path.join(process.cwd(), "firebase-applet-config.json");
let fbDb: any = null;

try {
  if (fs.existsSync(firebaseConfigPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, "utf-8"));
    let fbApp;
    if (getApps().length === 0) {
      fbApp = initializeApp(firebaseConfig);
    } else {
      fbApp = getApp();
    }
    // If the projectId is the user's custom 'rtn-support', use the default database '(default)'.
    // Otherwise, use the custom database ID if specified in config.
    const dbId = firebaseConfig.firestoreDatabaseId;
    if (dbId && dbId !== "(default)") {
      fbDb = getFirestore(fbApp, dbId);
      console.log(`Firebase JS SDK initialized successfully on server with database ID: ${dbId}`);
    } else {
      fbDb = getFirestore(fbApp);
      console.log(`Firebase JS SDK initialized successfully on server with default database`);
    }
  } else {
    console.warn("firebase-applet-config.json not found. Firestore features are disabled.");
  }
} catch (err) {
  console.error("Failed to initialize Firebase JS SDK on server:", err);
}

let db: any = null;
let dbLoadedPromise: Promise<any> | null = null;
let pendingSave: Promise<any> = Promise.resolve();
let isFirestoreLoadedSuccessfully = false;

const activeSessions = new Map<string, number>();

function getOnlineUsersCount() {
  const now = Date.now();
  for (const [key, timestamp] of activeSessions.entries()) {
    if (now - timestamp > 20000) {
      activeSessions.delete(key);
    }
  }
  return Math.max(3, activeSessions.size);
}

async function loadDbFromFirestore() {
  console.log("Loading DB from Firestore...");
  const keys = ["users", "products", "mails", "deposits", "submissions", "notices", "config", "chatMessages", "notifications"];
  const loadedDb: any = {};

  try {
    if (fbDb) {
      const promises = keys.map(async (key) => {
        const docRef = doc(fbDb, "rtn_data", key);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          const data = docSnap.data();
          loadedDb[key] = data.value || [];
        } else {
          loadedDb[key] = null;
        }
      });
      await Promise.all(promises);
      isFirestoreLoadedSuccessfully = true;
      console.log("DB Loaded successfully from Firestore!");
    } else {
      isFirestoreLoadedSuccessfully = false;
    }
  } catch (error: any) {
    console.error("Error loading DB from Firestore, falling back to local/default:", error.message || error);
    isFirestoreLoadedSuccessfully = false;
  }

  // Load local file fallback
  let localDb: any = {
    users: [],
    products: [],
    mails: [],
    deposits: [],
    submissions: [],
    notices: [],
    config: {
      referralBonusPercent: 5,
      bkashNumber: "01609166109",
      tokenToCodeLink: "https://code.yamin.bd/index.php/",
      twoFactorCodeLink: "https://2fa.cn/",
      whatsappGroupLink: "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr",
      adminWhatsApp: "8801609166109",
      developerWhatsApp: "8801609166109"
    },
    chatMessages: [],
    notifications: []
  };

  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, "utf-8");
      localDb = JSON.parse(data);
    }
  } catch (error) {
    console.error("Error reading local DB file fallback:", error);
  }

  // Merge loadedDb with localDb or defaults
  const finalDb: any = {};
  keys.forEach((key) => {
    if (loadedDb[key] !== null && loadedDb[key] !== undefined) {
      finalDb[key] = loadedDb[key];
    } else if (localDb && localDb[key] !== undefined) {
      finalDb[key] = localDb[key];
    } else {
      finalDb[key] = key === "config" ? {
        referralBonusPercent: 5,
        bkashNumber: "01609166109",
        tokenToCodeLink: "https://code.yamin.bd/index.php/",
        twoFactorCodeLink: "https://2fa.cn/",
        whatsappGroupLink: "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr",
        adminWhatsApp: "8801609166109",
        developerWhatsApp: "8801609166109"
      } : [];
    }
  });

  // Ensure config structure and fields exist
  if (!finalDb.config) {
    finalDb.config = {};
  }
  if (finalDb.config.referralBonusPercent === undefined) finalDb.config.referralBonusPercent = 5;
  if (!finalDb.config.bkashNumber || finalDb.config.bkashNumber === "01788888888") finalDb.config.bkashNumber = "01609166109";
  if (!finalDb.config.tokenToCodeLink || finalDb.config.tokenToCodeLink.includes("example.com")) finalDb.config.tokenToCodeLink = "https://code.yamin.bd/index.php/";
  if (!finalDb.config.twoFactorCodeLink || finalDb.config.twoFactorCodeLink.includes("example.com")) finalDb.config.twoFactorCodeLink = "https://2fa.cn/";
  if (!finalDb.config.whatsappGroupLink || finalDb.config.whatsappGroupLink.includes("GzB92f7X")) finalDb.config.whatsappGroupLink = "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr";
  if (!finalDb.config.adminWhatsApp || finalDb.config.adminWhatsApp === "8801788888888") finalDb.config.adminWhatsApp = "8801609166109";
  if (!finalDb.config.developerWhatsApp || finalDb.config.developerWhatsApp === "8801700000000") finalDb.config.developerWhatsApp = "8801609166109";
  if (finalDb.config.isPipraPayEnabled === undefined) finalDb.config.isPipraPayEnabled = false;

  // Clean up sourcingLink if it still exists in config
  if (finalDb.config.sourcingLink !== undefined) {
    delete finalDb.config.sourcingLink;
  }

  // Ensure products list is initialized
  if (!finalDb.products) finalDb.products = [];
  if (!finalDb.mails) finalDb.mails = [];
  if (!finalDb.deposits) finalDb.deposits = [];
  if (!finalDb.submissions) finalDb.submissions = [];
  if (!finalDb.notices) finalDb.notices = [];
  if (!finalDb.chatMessages) finalDb.chatMessages = [];
  if (!finalDb.notifications) finalDb.notifications = [];

  // Seed default products if empty
  const requiredProducts = [
    {
      id: "prod-9proxy-100mb-20tk",
      name: "9 proxy 100 mb 20 tk",
      description: "৯ প্রক্সি ১০০এমবি ২০ টাকা। এডমিন প্যানেল থেকে আপলোড করা প্রক্সি ইনস্ট্যান্ট ডেলিভারি পাবেন।",
      price: 20,
      stock: 0
    },
    {
      id: "prod-hotmail-fresh-1tk",
      name: "Hotmail Fresh",
      description: "হটমেইল ফ্রেশ অ্যাকাউন্ট ১ টাকা। মেইল ক্রয়ের পর ১ ঘণ্টা ওয়ারেন্টি পাবেন।",
      price: 1,
      stock: 0
    },
    {
      id: "prod-9proxy-1gb",
      name: "9 proxy 1gb 150 tk",
      description: "৯ প্রক্সি ১জিবি ১৫০ টাকা। ব্যবহারের পর রিভিউ দিতে ভুলবেন না।",
      price: 150,
      stock: 0
    },
    {
      id: "prod-owlproxy-200mb",
      name: "owl proxy 200 mb 20 taka",
      description: "আউল প্রক্সি ২০০এমবি ২০ টাকা। যেকোনো প্রয়োজনে হোয়াটসঅ্যাপে যোগাযোগ করুন।",
      price: 20,
      stock: 0
    },
    {
      id: "prod-chatgpt-plus-500tk",
      name: "ChatGPT Plus Personal",
      description: "চ্যাটজিপিটি প্লাস পার্সোনাল অ্যাকাউন্ট ৫০০ টাকা। ১ মাস মেয়াদি প্রিমিয়াম সাবস্ক্রিপশন।",
      price: 500,
      stock: 0
    },
    {
      id: "prod-gemini-18m-500tk",
      name: "Gemini 18 Month",
      description: "জেমিনি ১৮ মাস মেয়াদি প্রিমিয়াম অ্যাকাউন্ট ৫০০ টাকা। হাই কোয়ালিটি ফুল ওয়ারেন্টি।",
      price: 500,
      stock: 0
    }
  ];

  for (const reqP of requiredProducts) {
    if (!finalDb.products.some((p: any) => p.name.toLowerCase() === reqP.name.toLowerCase() || p.id === reqP.id)) {
      finalDb.products.push(reqP);
    }
  }

  // Ensure urgent notice is seeded
  if (finalDb.notices.length === 0) {
    finalDb.notices.push({
      id: "not-default",
      content: "আসসালামু আলাইকুম, আমাদের মেইল সেলিং ওয়েবসাইটে আপনাকে স্বাগতম। এখন থেকে আপনারা খুব সহজেই বিকাশ পেমেন্টের মাধ্যমে হটমেইল এবং আউটলুক অ্যাকাউন্ট ক্রয় করতে পারবেন। নতুন পণ্য নিয়মিত যুক্ত করা হচ্ছে। যেকোনো প্রয়োজনে লাইভ চ্যাট অথবা হোয়াটসঅ্যাপে যোগাযোগ করুন।\n\nওয়েবসাইটের নিয়মাবলী এবং তথ্যাবলী:\n১. মেইল ক্রয়ের সাথে সাথে পাসওয়ার্ড পরিবর্তন করে নিবেন। ক্রয়ের পর ১ ঘণ্টা ওয়ারেন্টি পাবেন।\n২. ব্যালেন্স এড করার সময় অবশ্যই সঠিক ট্রানজেকশন আইডি (TxID) এবং পাঠানোর বিকাশ নম্বরটি প্রদান করবেন।\n৩. কোনো মেইলে সমস্যা থাকলে তৎক্ষণাৎ এডমিন চ্যাট অথবা সরাসরি হোয়াটসঅ্যাপে যোগাযোগ করবেন।\n৪. রেফারেল লিংক শেয়ার করে বন্ধুদের ইনভাইট করুন এবং তাদের প্রতিটি ডিপোজিটে 5% বোনাস লুফে নিন।",
      createdAt: new Date().toISOString()
    });
  }

  // Ensure user sequences are correct and isAdmin is strictly configured
  if (finalDb.users) {
    finalDb.users.forEach((u: any, idx: number) => {
      if (u.id === "admin") {
        u.isAdmin = true;
      } else {
        u.isAdmin = u.isAdmin === true;
      }
      if (!u.rtnId) {
        u.rtnId = "rtn" + (idx + 1);
      }
    });
  }

  if (isFirestoreLoadedSuccessfully) {
    console.log("DB Loaded successfully from Firestore!");
  } else {
    console.log("DB Loaded from local file/defaults fallback (Firestore not successfully loaded yet).");
  }
  return finalDb;
}

async function saveDbToFirestore(data: any) {
  if (!fbDb) return;
  
  if (!isFirestoreLoadedSuccessfully) {
    console.warn("Skipping Firestore save to protect data because Firestore has not been loaded successfully in this session.");
    return;
  }

  console.log("Saving DB to Firestore...");
  const keys = ["users", "products", "mails", "deposits", "submissions", "notices", "config", "chatMessages", "notifications"];
  
  try {
    const promises = keys.map(async (key) => {
      const docRef = doc(fbDb, "rtn_data", key);
      await setDoc(docRef, { value: data[key] });
    });
    await Promise.all(promises);
    console.log("DB saved successfully to Firestore!");
  } catch (error) {
    console.error("Error saving DB to Firestore:", error);
  }
}

let lastLoadAttemptTime = 0;
let isAttemptingLoad = false;

async function retryLoadingFromFirestore() {
  if (isAttemptingLoad || !fbDb) return;
  isAttemptingLoad = true;
  lastLoadAttemptTime = Date.now();
  console.log("Retrying loading DB from Firestore in background...");
  try {
    const keys = ["users", "products", "mails", "deposits", "submissions", "notices", "config", "chatMessages", "notifications"];
    const loadedDb: any = {};
    const promises = keys.map(async (key) => {
      const docRef = doc(fbDb, "rtn_data", key);
      const docSnap = await getDoc(docRef);
      if (docSnap.exists()) {
        const data = docSnap.data();
        loadedDb[key] = data.value || [];
      } else {
        loadedDb[key] = null;
      }
    });
    await Promise.all(promises);
    
    // Merge loaded data with existing db
    const finalDb = readDB();
    keys.forEach((key) => {
      if (loadedDb[key] !== null && loadedDb[key] !== undefined) {
        // If Firestore had data, let's update our memory db with it
        finalDb[key] = loadedDb[key];
      }
    });
    
    db = finalDb;
    isFirestoreLoadedSuccessfully = true;
    console.log("Successfully connected and loaded DB from Firestore on retry!");
    
    // Immediately write back to Firestore to ensure consistency and upload any local updates
    try {
      fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf-8");
      // Since isFirestoreLoadedSuccessfully is now true, this will write to Firestore
      console.log("Performing full synchronization to Firestore after background recovery...");
      const promises = keys.map(async (key) => {
        const docRef = doc(fbDb, "rtn_data", key);
        await setDoc(docRef, { value: db[key] });
      });
      await Promise.all(promises);
      console.log("Background synchronization completed successfully!");
    } catch (saveErr) {
      console.error("Error saving merged DB to Firestore after recovery:", saveErr);
    }
  } catch (error: any) {
    console.error("Failed to load DB from Firestore on retry:", error.message || error);
    isFirestoreLoadedSuccessfully = false;
  } finally {
    isAttemptingLoad = false;
  }
}

async function ensureDbLoaded() {
  if (!db) {
    if (!dbLoadedPromise) {
      dbLoadedPromise = (async () => {
        try {
          lastLoadAttemptTime = Date.now();
          db = await loadDbFromFirestore();
          return db;
        } catch (err) {
          console.error("Critical error in ensureDbLoaded, using hardcoded default DB schema:", err);
          db = {
            users: [],
            products: [],
            mails: [],
            deposits: [],
            submissions: [],
            notices: [],
            config: {
              referralBonusPercent: 5,
              bkashNumber: "01609166109",
              tokenToCodeLink: "https://code.yamin.bd/index.php/",
              twoFactorCodeLink: "https://2fa.cn/",
              whatsappGroupLink: "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr",
              adminWhatsApp: "8801609166109",
              developerWhatsApp: "8801609166109"
            },
            chatMessages: [],
            notifications: []
          };
          return db;
        }
      })();
    }
    await dbLoadedPromise;
  }

  // If Firestore is still not loaded successfully, retry in the background periodically (5 min throttle)
  if (!isFirestoreLoadedSuccessfully && fbDb && Date.now() - lastLoadAttemptTime > 300000) {
    retryLoadingFromFirestore();
  }
  
  return db;
}

function readDB() {
  if (db) return db;
  // Fallback if not loaded
  return {
    users: [],
    products: [],
    mails: [],
    deposits: [],
    submissions: [],
    notices: [],
    config: {
      referralBonusPercent: 5,
      bkashNumber: "01609166109",
      tokenToCodeLink: "https://code.yamin.bd/index.php/",
      twoFactorCodeLink: "https://2fa.cn/",
      whatsappGroupLink: "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr",
      adminWhatsApp: "8801609166109",
      developerWhatsApp: "8801609166109"
    },
    chatMessages: [],
    notifications: []
  };
}

function writeDB(data: any) {
  db = data;
  
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf-8");
  } catch (error) {
    console.error("Error writing to local database file", error);
  }

  if (fbDb) {
    pendingSave = pendingSave.then(async () => {
      try {
        await saveDbToFirestore(data);
      } catch (err) {
        console.error("Failed to save DB to Firestore", err);
      }
    });
  }
}

// Helper to send emails
async function sendNotificationEmail(to: string, subject: string, htmlContent: string) {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const senderName = process.env.SMTP_SENDER_NAME || "RTN Premium Store";

  if (!user || !pass) {
    console.warn(`[Email Notification] SMTP_USER or SMTP_PASS not set. Email notification to ${to} is simulated. Subject: ${subject}`);
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });

    const mailOptions = {
      from: `"${senderName}" <${user}>`,
      to,
      subject,
      html: htmlContent,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log(`[Email Notification] Email sent successfully to ${to}: ${info.messageId}`);
    return true;
  } catch (error) {
    console.error(`[Email Notification] Failed to send email to ${to}:`, error);
    return false;
  }
}

// Helper to create notifications (both in-app and email)
async function createNotification(userId: string, title: string, message: string, type: 'info' | 'success' | 'warning' | 'danger') {
  const freshDb = readDB();
  if (!freshDb.notifications) {
    freshDb.notifications = [];
  }

  const newNotification = {
    id: "notif-" + Math.random().toString(36).substring(2, 9).toUpperCase() + Date.now(),
    userId,
    title,
    message,
    type,
    isRead: false,
    createdAt: new Date().toISOString()
  };

  freshDb.notifications.push(newNotification);
  writeDB(freshDb);

  // If userId is specific, check if they have an email address to send a notification to
  if (userId && userId !== "all" && userId !== "admin") {
    const userObj = freshDb.users.find((u: any) => u.id === userId);
    if (userObj && userObj.email && userObj.email.trim() !== "") {
      const emailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 20px; padding: 28px; color: #1e293b; background-color: #ffffff; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05);">
          <div style="text-align: center; margin-bottom: 24px;">
            <h1 style="color: #4f46e5; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">RTN PREMIUM STORE</h1>
            <p style="font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: #64748b; margin: 4px 0 0 0; font-weight: 700;">Verified Digital Notification</p>
          </div>
          <div style="background-color: #f8fafc; border-radius: 16px; padding: 20px; border: 1px solid #f1f5f9;">
            <h2 style="color: #1e293b; margin: 0 0 12px 0; font-size: 18px; font-weight: 700;">${title}</h2>
            <div style="font-size: 14px; line-height: 1.6; color: #334155; white-space: pre-line;">
              ${message}
            </div>
          </div>
          <div style="margin-top: 24px; text-align: center; font-size: 11px; color: #94a3b8; border-top: 1px dashed #e2e8f0; padding-top: 20px;">
            এটি একটি স্বয়ংক্রিয় ইমেইল নোটিফিকেশন। দয়া করে এখানে সরাসরি উত্তর দিবেন না।<br/>
            যেকোনো প্রয়োজনে আমাদের লাইভ চ্যাট অথবা হোয়াটসঅ্যাপে যোগাযোগ করুন।<br/>
            <strong style="color: #4f46e5; display: inline-block; margin-top: 8px;">RTN Support - Fast & Auto Delivery Mail Store</strong>
          </div>
        </div>
      `;
      // Send email asynchronously
      sendNotificationEmail(userObj.email, `[RTN Store] ${title}`, emailHtml)
        .catch(err => console.error("Error in sendNotificationEmail background thread:", err));
    }
  }
}

// Global helper for approving deposits
function approveDepositInternal(db: any, depositId: string) {
  const depositIndex = db.deposits.findIndex((d: any) => d.id === depositId);
  if (depositIndex === -1) return false;

  const deposit = db.deposits[depositIndex];
  if (deposit.status !== "pending") return false;

  const userIndex = db.users.findIndex((u: any) => u.id === deposit.userId);
  if (userIndex === -1) return false;

  // Approve the deposit
  db.deposits[depositIndex].status = "approved";
  db.deposits[depositIndex].approvedAt = new Date().toISOString();

  // Add balance to user
  db.users[userIndex].balance += deposit.amount;

  const depositor = db.users[userIndex];
  const formattedAmount = deposit.amount;

  // Create user notification and send email
  createNotification(
    depositor.id,
    "ব্যালেন্স ডিপোজিট সফল হয়েছে! ✅",
    `প্রিয় গ্রাহক, আপনার ওয়ালেটে সফলভাবে ৳${formattedAmount} যোগ করা হয়েছে।\nপেমেন্ট মেথড: ${deposit.bKashNumber.includes("Pipra") ? "Pipra Pay (অটোমেটিক)" : "বিকাশ (ম্যানুয়াল)"}\nট্রানজেকশন আইডি: ${deposit.transactionId}\nবর্তমান ওয়ালেট ব্যালেন্স: ৳${db.users[userIndex].balance.toFixed(2)}।\n\nRTN Premium Store ব্যবহার করার জন্য আপনাকে ধন্যবাদ!`,
    "success"
  );

  // Notify admin
  createNotification(
    "admin",
    "নতুন ডিপোজিট সফল 💰",
    `ইউজার ${depositor.rtnId || depositor.id} এর ৳${formattedAmount} ডিপোজিট সফলভাবে প্রসেস হয়েছে।\nপেমেন্ট মেথড: ${deposit.bKashNumber}\nট্রানজেকশন আইডি: ${deposit.transactionId}।`,
    "info"
  );

  // Process referral bonus
  if (depositor.referredBy) {
    const referrerIndex = db.users.findIndex((u: any) => u.id === depositor.referredBy);
    if (referrerIndex !== -1) {
      const bonusPercent = db.config.referralBonusPercent || 5;
      const bonusAmount = Number(((deposit.amount * bonusPercent) / 100).toFixed(2));
      db.users[referrerIndex].balance += bonusAmount;

      createNotification(
        depositor.referredBy,
        "রেফারেল বোনাস ক্রেডিট হয়েছে! 🎉",
        `আপনার আমন্ত্রিত ব্যবহারকারী (${depositor.rtnId || depositor.id}) ৳${formattedAmount} ব্যালেন্স যুক্ত করেছেন। আপনি ${bonusPercent}% হারে ৳${bonusAmount} বোনাস ব্যালেন্স পেয়েছেন!`,
        "success"
      );

      db.chatMessages.push({
        id: "chat-system-" + Date.now(),
        userId: depositor.referredBy,
        sender: "admin",
        message: `অভিনন্দন! আপনার রেফারেল ব্যবহারকারী (${depositor.rtnId || depositor.id}) ৳${deposit.amount} ব্যালেন্স যুক্ত করেছেন। আপনি ${bonusPercent}% হারে ৳${bonusAmount} রেফারেল বোনাস পেয়েছেন!`,
        createdAt: new Date().toISOString()
      });
    }
  }

  return true;
}

// Request processing and save queue synchronization middleware
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    try {
      await ensureDbLoaded();

      // Track session heartbeat
      const ip = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "unknown").split(",")[0].trim();
      const authHeader = req.headers.authorization;
      let sessionKey = ip;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        sessionKey = authHeader.split(" ")[1] + "_" + ip;
      }
      activeSessions.set(sessionKey, Date.now());
      
      // Override res.send and res.json to wait for pendingSave
      const originalSend = res.send;
      const originalJson = res.json;
      
      res.send = function(body) {
        pendingSave.then(() => {
          originalSend.call(this, body);
        }).catch((err) => {
          console.error("Error waiting for pendingSave on send:", err);
          originalSend.call(this, body);
        });
        return this;
      };
      
      res.json = function(body) {
        pendingSave.then(() => {
          originalJson.call(this, body);
        }).catch((err) => {
          console.error("Error waiting for pendingSave on json:", err);
          originalJson.call(this, body);
        });
        return this;
      };
      
      next();
    } catch (err) {
      res.status(500).json({ error: "Database initialization failed." });
    }
  } else {
    next();
  }
});

app.get("/api/online-count", (req, res) => {
  res.json({ count: getOnlineUsersCount() });
});

app.post("/api/hotmail-messages", async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res.status(400).json({ error: "Access token is required" });
    }

    const response = await fetch("https://graph.microsoft.com/v1.0/me/messages?$select=subject,bodyPreview,receivedDateTime,from&$top=10", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Microsoft Graph API error details:", errText);
      try {
        const errJson = JSON.parse(errText);
        const errMsg = errJson.error?.message || "মেয়াদোত্তীর্ণ বা অবৈধ টোকেন প্রদান করা হয়েছে।";
        return res.status(response.status).json({ error: `মাইক্রোসফট গ্রাফ এপিআই ত্রুটি: ${errMsg}` });
      } catch (parseErr) {
        return res.status(response.status).json({ error: "মাইক্রোসফট এপিআই এর সাথে সংযোগ স্থাপন করা সম্ভব হয়নি। টোকেনটি পরীক্ষা করুন।" });
      }
    }

    const data = await response.json();
    return res.json(data);
  } catch (err: any) {
    console.error("Hotmail Messages proxy error:", err);
    return res.status(500).json({ error: err.message || "সার্ভার ইন্টারনাল ত্রুটি। আবার চেষ্টা করুন।" });
  }
});

// Sync Product Mails from Google Sheet as CSV helper
async function syncMailsFromGoogleSheet(productId: string) {
  const db = readDB();
  const product = db.products.find((p: any) => p.id === productId);
  if (!product || !product.googleSheetUrl) return 0;

  try {
    const sheetUrl = product.googleSheetUrl.trim();
    // Match spreadsheet ID
    const sheetIdMatch = sheetUrl.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (!sheetIdMatch) {
      console.error("Invalid Google Sheet URL format:", sheetUrl);
      return 0;
    }
    const sheetId = sheetIdMatch[1];
    // Add cache buster timestamp to bypass any Google Sheets export caching
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&t=${Date.now()}`;

    const response = await fetch(csvUrl);
    if (!response.ok) {
      throw new Error(`Google Sheets export returned status ${response.status}`);
    }

    const csvData = await response.text();
    const lines = csvData.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    let addedCount = 0;
    const existingMails = new Set(
      db.mails
        .filter((m: any) => m.productId === productId)
        .map((m: any) => m.content.trim())
    );

    for (const rawLine of lines) {
      let cleanedLine = "";
      
      // Robust CSV parsing for cells taking into account quotes and comma/semicolon delimiters
      const cells: string[] = [];
      let currentCell = "";
      let inQuotes = false;
      for (let i = 0; i < rawLine.length; i++) {
        const char = rawLine[i];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if ((char === ',' || char === ';') && !inQuotes) {
          cells.push(currentCell.trim());
          currentCell = "";
        } else {
          currentCell += char;
        }
      }
      cells.push(currentCell.trim());

      // Clean individual cells of surrounding quotes
      const cleanedCells = cells
        .map(cell => cell.replace(/^"|"$/g, '').trim())
        .filter(cell => cell.length > 0);

      if (cleanedCells.length > 1) {
        cleanedLine = cleanedCells.join(":");
      } else {
        let lineVal = rawLine.replace(/^"|"$/g, '').trim();
        if (lineVal.includes("|")) {
          lineVal = lineVal.split("|").map(s => s.trim()).join(":");
        }
        cleanedLine = lineVal;
      }

      // Basic filtering for headers or metadata
      const lower = cleanedLine.toLowerCase();
      if (
        lower === "email:password:recovery" ||
        lower === "mail:pass:recovery" ||
        lower.startsWith("email,password") ||
        lower.startsWith("username,password") ||
        lower.startsWith("email:password") ||
        lower === "email:password" ||
        lower === "username:password"
      ) {
        continue; // skip spreadsheet header
      }

      if (!existingMails.has(cleanedLine)) {
        db.mails.push({
          id: "mail-" + Date.now() + "-" + Math.floor(Math.random() * 1000000),
          productId,
          content: cleanedLine,
          isSold: false,
          soldTo: null,
          soldAt: null,
          createdAt: new Date().toISOString()
        });
        existingMails.add(cleanedLine);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      writeDB(db);
    }
    return addedCount;
  } catch (err) {
    console.error("Error syncing from Google Sheets:", err);
    throw err;
  }
}

// Authentication Middleware
function authMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const userId = req.headers["x-user-id"] as string;
  const password = req.headers["x-user-password"] as string;

  if (!userId) {
    res.status(401).json({ error: "অননুমোদিত অ্যাক্সেস! অনুগ্রহ করে লগইন করুন।" });
    return;
  }

  const db = readDB();

  // Support Virtual Admin
  if (userId === "admin" && password === "2026") {
    (req as any).user = {
      id: "admin",
      password: "2026",
      isAdmin: true,
      displayName: "System Admin",
      balance: 0,
      role: "super_admin"
    };
    next();
    return;
  }

  const user = db.users.find((u: any) => u.id === userId);

  if (!user || user.password !== password) {
    res.status(401).json({ error: "লগইন তথ্য সঠিক নয় অথবা ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  if (user.isBlocked) {
    res.status(403).json({ error: "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে। দয়া করে এডমিনের সাথে যোগাযোগ করুন।" });
    return;
  }

  if (user.isSuspended) {
    res.status(403).json({ error: "আপনার অ্যাকাউন্টটি সাময়িকভাবে স্থগিত (Suspended) করা হয়েছে। অনুগ্রহ করে এডমিনের সাথে যোগাযোগ করুন।" });
    return;
  }

  // Maintenance mode blocks write actions (POST) for non-admins
  if (db.config && db.config.isMaintenanceMode && !user.isAdmin && req.method !== "GET" && req.path !== "/api/auth/login") {
    res.status(503).json({ error: "সিস্টেম বর্তমানে রক্ষণাবেক্ষণ (Maintenance Mode) মোডে রয়েছে। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।" });
    return;
  }

  (req as any).user = user;
  next();
}

// Admin Check Middleware
function adminMiddleware(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user;
  if (!user || !user.isAdmin) {
    res.status(430).json({ error: "এই কাজটি করার জন্য আপনার এডমিন ক্ষমতা নেই।" });
    return;
  }

  // Multi-Admin Role restrictions
  const role = user.role || "super_admin";
  const path = req.path;
  const isWrite = req.method !== "GET";

  if (role === "support") {
    // Support can only do GET requests, or send admin chats
    if (isWrite && path !== "/api/admin/chat/send") {
      res.status(403).json({ error: "সাপোর্ট এডমিন হিসেবে আপনার এই কাজটি করার অনুমতি নেই।" });
      return;
    }
  } else if (role === "moderator") {
    // Moderator can do most things, but not update config, roles, or view backups
    const restrictedPaths = [
      "/api/admin/config/update",
      "/api/admin/users/update-role",
      "/api/admin/backup"
    ];
    if (restrictedPaths.some(p => path.startsWith(p))) {
      res.status(403).json({ error: "মডারেটর হিসেবে আপনার এই স্পর্শকাতর কাজটি করার অনুমতি নেই।" });
      return;
    }
  }

  next();
}

// API Routes

// 1. Auth routes
app.post("/api/auth/register", (req, res) => {
  const { id, password, referredBy } = req.body;

  if (!id || !password) {
    res.status(400).json({ error: "বিকাশ নম্বর এবং পাসওয়ার্ড আবশ্যিক।" });
    return;
  }

  // Verify Bangladeshi phone format
  const phoneRegex = /^01[3-9]\d{8}$/;
  if (!phoneRegex.test(id)) {
    res.status(400).json({ error: "অনুগ্রহ করে একটি সঠিক বাংলাদেশী ১১-ডিজিটের সচল বিকাশ নম্বর দিন (যেমন: 01712345678)" });
    return;
  }

  const db = readDB();
  const existingUser = db.users.find((u: any) => u.id === id);
  if (existingUser) {
    res.status(400).json({ error: "এই বিকাশ নম্বরটি দিয়ে ইতিমধ্যে রেজিস্ট্রেশন করা হয়েছে।" });
    return;
  }

  // Validate referredBy if provided
  let referrerId = null;
  if (referredBy && referredBy.trim() !== "") {
    const cleanReferrer = referredBy.trim();
    const referrer = db.users.find((u: any) => u.id === cleanReferrer);
    if (referrer) {
      referrerId = cleanReferrer;
    } else {
      res.status(400).json({ error: "প্রদত্ত রেফারেল বিকাশ নম্বরটি সিস্টেমে খুঁজে পাওয়া যায়নি।" });
      return;
    }
  }

  const newUser = {
    id,
    password,
    rtnId: "rtn" + (db.users.length + 1),
    balance: 0,
    referredBy: referrerId,
    createdAt: new Date().toISOString(),
    isBlocked: false,
    isAdmin: false,
    isSuspended: false,
    isVerified: false,
    role: 'support',
    lastLogin: new Date().toISOString(),
    loyaltyPoints: 10 // 10 points free welcome bonus!
  };

  db.users.push(newUser);

  // Auto Welcome Message in Chat
  const welcomeMessage = {
    id: "chat-welcome-" + Date.now(),
    userId: newUser.id,
    sender: "admin",
    message: "স্বাগতম! RTN Premium Mail Store-এ আপনাকে স্বাগতম। আপনার অ্যাকাউন্টটি সফলভাবে তৈরি করা হয়েছে এবং উপহারস্বরূপ ১০ লয়্যালটি পয়েন্ট দেওয়া হয়েছে। যেকোনো সাহায্য বা তথ্যের জন্য আমাদের সাপোর্ট চ্যাটে যোগাযোগ করুন বা আমাদের এআই অ্যাসিস্ট্যান্টকে প্রশ্ন করুন।",
    createdAt: new Date().toISOString()
  };
  if (!db.chatMessages) db.chatMessages = [];
  db.chatMessages.push(welcomeMessage);

  // Create registration notification
  const isWelcomeEnabled = db.config.isAutomationWelcomeEnabled !== false;
  if (isWelcomeEnabled) {
    if (!db.notifications) db.notifications = [];
    db.notifications.push({
      id: "welcome-notif-" + Date.now(),
      userId: newUser.id,
      title: "অ্যাকাউন্ট তৈরি সফল! 🎉",
      message: "প্রিয় গ্রাহক, RTN Premium Mail Store-এ আপনাকে স্বাগতম! আপনার মেইল কেনাবেচার যাত্রা শুভ হোক। যেকোনো প্রয়োজনে সাহায্য পেতে লাইভ চ্যাট ট্যাব ব্যবহার করুন।",
      type: "success",
      isRead: false,
      createdAt: new Date().toISOString()
    });
  }

  writeDB(db);

  res.json({ message: "রেজিস্ট্রেশন সফল হয়েছে!", user: { id: newUser.id, balance: newUser.balance, isAdmin: newUser.isAdmin, rtnId: newUser.rtnId, loyaltyPoints: newUser.loyaltyPoints } });
});

app.post("/api/auth/login", (req, res) => {
  const { id, password } = req.body;

  if (!id || !password) {
    res.status(400).json({ error: "বিকাশ নম্বর এবং পাসওয়ার্ড আবশ্যিক।" });
    return;
  }

  const db = readDB();
  // Find user by either id, bKashNumber, whatsAppNumber, or email
  const user = db.users.find((u: any) => 
    u.id === id || 
    (u.email && u.email.toLowerCase() === id.toLowerCase()) || 
    (u.bKashNumber && u.bKashNumber === id) || 
    (u.whatsAppNumber && u.whatsAppNumber === id)
  );

  if (!user || user.password !== password) {
    res.status(401).json({ error: "মোবাইল নম্বর/ইমেইল অথবা পাসওয়ার্ডটি সঠিক নয়।" });
    return;
  }

  if (user.isBlocked) {
    res.status(403).json({ error: "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে।" });
    return;
  }

  if (user.isSuspended) {
    res.status(403).json({ error: "আপনার অ্যাকাউন্টটি সাময়িকভাবে স্থগিত (Suspended) করা হয়েছে। অনুগ্রহ করে এডমিনের সাথে যোগাযোগ করুন।" });
    return;
  }

  // Update lastLogin and earn 1 loyalty point per login
  user.lastLogin = new Date().toISOString();
  if (user.loyaltyPoints === undefined) {
    user.loyaltyPoints = 10;
  } else {
    user.loyaltyPoints += 1;
  }
  writeDB(db);

  res.json({
    message: "লগইন সফল হয়েছে!",
    user: {
      id: user.id,
      balance: user.balance,
      isAdmin: user.isAdmin,
      referredBy: user.referredBy,
      rtnId: user.rtnId || "",
      isVerified: !!user.isVerified,
      role: user.role || 'support',
      lastLogin: user.lastLogin,
      loyaltyPoints: user.loyaltyPoints
    }
  });
});

app.post("/api/auth/google", (req, res) => {
  const { email, displayName, uid, photoURL, referredBy } = req.body;

  if (!email || !uid) {
    res.status(400).json({ error: "গুগল অ্যাকাউন্ট আইডি ও ইমেইল আবশ্যক।" });
    return;
  }

  const db = readDB();
  
  // Find user by either googleUid, email, or id matching email
  let user = db.users.find((u: any) => u.googleUid === uid || u.email === email || u.id === email);

  if (!user) {
    const baseId = email.split("@")[0];
    let finalId = baseId;
    let count = 1;
    while (db.users.some((u: any) => u.id === finalId)) {
      finalId = baseId + count;
      count++;
    }

    // Validate referredBy if provided
    let referrerId = null;
    if (referredBy && referredBy.trim() !== "") {
      const cleanReferrer = referredBy.trim();
      const referrer = db.users.find((u: any) => u.id === cleanReferrer);
      if (referrer) {
        referrerId = cleanReferrer;
      }
    }

    user = {
      id: finalId,
      email: email,
      googleUid: uid,
      displayName: displayName || baseId,
      avatarUrl: photoURL || "",
      balance: 0,
      referredBy: referrerId,
      createdAt: new Date().toISOString(),
      isBlocked: false,
      isAdmin: false,
      password: Math.random().toString(36).slice(-10) + "-G",
      rtnId: "rtn" + (db.users.length + 1),
      lastLogin: new Date().toISOString(),
      loyaltyPoints: 10
    };

    db.users.push(user);
    writeDB(db);
  } else {
    if (user.isBlocked) {
      res.status(403).json({ error: "আপনার অ্যাকাউন্টটি ব্লক করা হয়েছে।" });
      return;
    }
    // Update lastLogin and earn 1 loyalty point per login
    user.lastLogin = new Date().toISOString();
    if (user.loyaltyPoints === undefined) {
      user.loyaltyPoints = 10;
    } else {
      user.loyaltyPoints += 1;
    }
    let updated = true;
    if (!user.displayName && displayName) {
      user.displayName = displayName;
    }
    if (!user.avatarUrl && photoURL) {
      user.avatarUrl = photoURL;
    }
    if (!user.googleUid) {
      user.googleUid = uid;
    }
    if (!user.email) {
      user.email = email;
    }
    if (!user.password) {
      user.password = Math.random().toString(36).slice(-10) + "-G";
    }
    writeDB(db);
  }

  res.json({
    message: "গুগল লগইন সফল হয়েছে!",
    user: {
      id: user.id,
      password: user.password,
      balance: user.balance,
      isAdmin: user.isAdmin,
      referredBy: user.referredBy,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      rtnId: user.rtnId || "",
      lastLogin: user.lastLogin,
      loyaltyPoints: user.loyaltyPoints,
      email: user.email || ""
    }
  });
});

app.post("/api/auth/verify-admin-pass", (req, res) => {
  const { password } = req.body;

  if (!password) {
    res.status(400).json({ error: "পাসওয়ার্ড প্রদান করা আবশ্যক।" });
    return;
  }

  if (password === "2026") {
    res.json({ success: true });
  } else {
    res.status(400).json({
      success: false,
      error: "ভুল পাসওয়ার্ড! সঠিক পাসওয়ার্ড দিয়ে চেষ্টা করুন।"
    });
  }
});

// 2. Public configs & notices
app.get("/api/config", (req, res) => {
  const db = readDB();
  res.json(db.config);
});

app.get("/api/notice", (req, res) => {
  const db = readDB();
  res.json(db.notices);
});

// 3. User features (Requires auth)
app.get("/api/user/profile", authMiddleware, (req, res) => {
  const user = (req as any).user;
  res.json({
    id: user.id,
    balance: user.balance,
    isAdmin: user.isAdmin,
    referredBy: user.referredBy,
    displayName: user.displayName || "",
    avatarUrl: user.avatarUrl || "",
    bKashNumber: user.bKashNumber || user.id, // default to register phone
    whatsAppNumber: user.whatsAppNumber || "",
    email: user.email || "",
    password: user.password || "",
    rtnId: user.rtnId || ""
  });
});

app.post("/api/user/profile/update", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { displayName, avatarUrl, bKashNumber, whatsAppNumber, password, email } = req.body;
  
  const db = readDB();
  const dbUser = db.users.find((u: any) => u.id === user.id);
  if (dbUser) {
    dbUser.displayName = displayName || "";
    dbUser.avatarUrl = avatarUrl || "";
    dbUser.bKashNumber = bKashNumber || user.id;
    dbUser.whatsAppNumber = whatsAppNumber || "";
    dbUser.email = email || "";
    if (password && password.trim() !== "") {
      dbUser.password = password;
    }
    writeDB(db);
    res.json({
      success: true,
      displayName: dbUser.displayName,
      avatarUrl: dbUser.avatarUrl,
      bKashNumber: dbUser.bKashNumber,
      whatsAppNumber: dbUser.whatsAppNumber,
      email: dbUser.email
    });
  } else {
    res.status(404).json({ error: "ইউজার পাওয়া যায়নি।" });
  }
});

// Get products with computed stock (with Google Sheet auto-syncing)
app.get("/api/products", async (req, res) => {
  const db = readDB();
  const sheetProducts = db.products.filter((p: any) => p.googleSheetUrl);
  for (const p of sheetProducts) {
    try {
      await syncMailsFromGoogleSheet(p.id);
    } catch (e) {
      console.error(`Auto-sync failed for product ${p.id}:`, e);
    }
  }

  // Reload DB to reflect newly synced mails
  const updatedDb = readDB();
  const productsWithStock = updatedDb.products.map((prod: any) => {
    const unsoldMailsCount = updatedDb.mails.filter((m: any) => m.productId === prod.id && !m.isSold).length;
    return {
      ...prod,
      stock: unsoldMailsCount
    };
  });
  res.json(productsWithStock);
});

// Purchase route
app.post("/api/buy", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { productId, quantity } = req.body;

  if (!productId || !quantity || quantity <= 0) {
    res.status(400).json({ error: "সঠিক পণ্য আইডি এবং পরিমাণ প্রদান করুন।" });
    return;
  }

  const db = readDB();
  const product = db.products.find((p: any) => p.id === productId);
  if (!product) {
    res.status(404).json({ error: "পণ্যটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  // Sync Google Sheet right before buy if configured!
  if (product.googleSheetUrl) {
    try {
      await syncMailsFromGoogleSheet(productId);
    } catch (e) {
      console.error("Auto-sync during purchase failed:", e);
    }
  }

  // Read DB again to get newly synced mails
  const freshDb = readDB();
  const availableMails = freshDb.mails.filter((m: any) => m.productId === productId && !m.isSold);
  if (availableMails.length < quantity) {
    res.status(400).json({ error: `পর্যাপ্ত স্টক নেই! উপলব্ধ স্টক: ${availableMails.length} টি।` });
    return;
  }

  // Calculate User Level and Discount based on historical spend
  const userMails = freshDb.mails.filter((m: any) => m.soldTo === user.id && m.isSold);
  const totalSpent = userMails.reduce((sum: number, m: any) => {
    const p = freshDb.products.find((prod: any) => prod.id === m.productId);
    return sum + (p ? p.price : 0);
  }, 0);
  const { level, discountPercent } = getUserLevelAndDiscount(totalSpent);

  const originalPrice = product.price * quantity;
  const discountAmount = Math.floor(originalPrice * (discountPercent / 100));
  const totalPrice = originalPrice - discountAmount;

  if (user.balance < totalPrice) {
    res.status(400).json({ error: `আপনার ব্যালেন্স পর্যাপ্ত নয়! প্রদেয়: ৳${totalPrice} (লেভেল ${level} এর জন্য ৳${discountAmount} ছাড় সহ), বর্তমান ব্যালেন্স: ৳${user.balance}` });
    return;
  }

  // Process purchase
  const boughtMails: any[] = [];
  let allocated = 0;

  for (const mail of freshDb.mails) {
    if (mail.productId === productId && !mail.isSold && allocated < quantity) {
      mail.isSold = true;
      mail.soldTo = user.id;
      mail.soldAt = new Date().toISOString();
      boughtMails.push(mail);
      allocated++;
    }
  }

  // Deduct balance from user in database
  const userIndex = freshDb.users.findIndex((u: any) => u.id === user.id);
  freshDb.users[userIndex].balance -= totalPrice;

  // Award Loyalty Points (1 point per 100 Tk spent, min 1)
  const earnedPoints = Math.max(1, Math.floor(totalPrice / 100));
  freshDb.users[userIndex].loyaltyPoints = (freshDb.users[userIndex].loyaltyPoints || 0) + earnedPoints;

  // Auto Low Balance Alert (if balance < 50)
  const isLowBalanceAlertEnabled = freshDb.config.isAutomationLowBalanceEnabled !== false;
  const newBalance = freshDb.users[userIndex].balance;
  if (isLowBalanceAlertEnabled && newBalance < 50) {
    const notificationsList = freshDb.notifications || [];
    notificationsList.push({
      id: "low-bal-" + Date.now(),
      userId: user.id,
      title: "কম ব্যালেন্স সতর্কতা ⚠️",
      message: `প্রিয় গ্রাহক, আপনার ব্যালেন্স ৳${newBalance.toFixed(2)} এ নেমে এসেছে। নিরবচ্ছিন্ন সেবা উপভোগ করতে অনুগ্রহ করে রিচার্জ করুন।`,
      type: "warning",
      isRead: false,
      createdAt: new Date().toISOString()
    });
    freshDb.notifications = notificationsList;
  }

  // Auto Low Stock Alert (if stock < 5)
  const isLowStockAlertEnabled = freshDb.config.isAutomationLowStockEnabled !== false;
  const remainingStock = availableMails.length - quantity;
  if (isLowStockAlertEnabled && remainingStock < 5) {
    const notificationsList = freshDb.notifications || [];
    notificationsList.push({
      id: "low-stock-" + Date.now() + "-" + productId,
      userId: "admin",
      title: "নিম্ন স্টক অ্যালার্ট ⚠️",
      message: `পণ্য "${product.name}" এর স্টক ফুরিয়ে আসছে! বর্তমান স্টক: ${remainingStock} টি। অনুগ্রহ করে নতুন স্টক যুক্ত করুন।`,
      type: "danger",
      isRead: false,
      createdAt: new Date().toISOString()
    });
    freshDb.notifications = notificationsList;
  }

  writeDB(freshDb);

  // Trigger Notifications & Emails asynchronously
  const mailListText = boughtMails.map((m: any, idx: number) => `${idx + 1}. ${m.content}`).join("\n");

  createNotification(
    user.id,
    "পণ্য ক্রয় সফল হয়েছে! 🛍️",
    `প্রিয় গ্রাহক, আপনি সফলভাবে "${product.name}" ক্রয় করেছেন।\n\nপণ্য বিবরণ: ${product.name}\nলেভেল: ${level} (৳${discountAmount} ছাড়)\nক্রয়কৃত পরিমাণ: ${quantity} টি\nমোট মূল্য: ৳${totalPrice}\nওয়ালেট ব্যালেন্স থেকে কর্তন করা হয়েছে: ৳${totalPrice}\nবর্তমান ব্যালেন্স: ৳${newBalance.toFixed(2)}\nলয়ালটি পয়েন্ট যুক্ত হয়েছে: +${earnedPoints}\n\nডেলিভারিকৃত মেইল ক্রেডেনশিয়াল সমূহ:\n${mailListText}\n\nআপনার যেকোনো প্রয়োজনে লাইভ চ্যাট অথবা হোয়াটসঅ্যাপে যোগাযোগ করুন।`,
    "success"
  ).catch(err => console.error("Error creating purchase notification:", err));

  createNotification(
    "admin",
    "নতুন পণ্য বিক্রয় 🛒",
    `ব্যবহারকারী ${user.rtnId || user.id} সফলভাবে "${product.name}" ক্রয় করেছেন।\n\nপরিমাণ: ${quantity} টি\nমোট মূল্য: ৳${totalPrice} (ছাড়: ৳${discountAmount})।`,
    "info"
  ).catch(err => console.error("Error creating admin purchase notification:", err));

  res.json({
    message: "ক্রয় সফল হয়েছে!",
    purchasedMails: boughtMails.map((m: any) => m.content),
    totalDeducted: totalPrice,
    newBalance: newBalance,
    discountAmount,
    level,
    earnedPoints
  });
});

// Get user deposit & purchase history
app.get("/api/user/history", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const db = readDB();

  const userDeposits = db.deposits.filter((d: any) => d.userId === user.id);
  
  // Find all purchased mails
  const userPurchases = db.mails
    .filter((m: any) => m.soldTo === user.id)
    .map((m: any) => {
      const prod = db.products.find((p: any) => p.id === m.productId);
      return {
        id: m.id,
        productName: prod ? prod.name : "Unknown Mail Product",
        content: m.content,
        price: prod ? prod.price : 0,
        soldAt: m.soldAt
      };
    });

  // Find users who have registered using this user's ID as referral
  const referrals = db.users
    .filter((u: any) => u.referredBy === user.id)
    .map((u: any) => ({
      id: u.id,
      createdAt: u.createdAt,
      totalDepositedByThem: db.deposits
        .filter((d: any) => d.userId === u.id && d.status === "approved")
        .reduce((sum: number, d: any) => sum + d.amount, 0)
    }));

  const userSubmissions = db.submissions ? db.submissions.filter((s: any) => s.userId === user.id) : [];

  res.json({
    deposits: userDeposits,
    purchases: userPurchases,
    referrals: referrals,
    submissions: userSubmissions
  });
});

// Submit deposit request
app.post("/api/deposit", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { amount, bKashNumber, transactionId, screenshot } = req.body;

  if (!amount || amount <= 0 || !bKashNumber || !transactionId) {
    res.status(400).json({ error: "সবগুলো ফিল্ড সঠিকভাবে পূরণ করুন।" });
    return;
  }

  const db = readDB();

  // Prevent duplicate transactionId
  const dup = db.deposits.find((d: any) => d.transactionId.trim().toUpperCase() === transactionId.trim().toUpperCase());
  if (dup) {
    res.status(400).json({ error: "এই ট্রানজেকশন আইডিটি ইতিমধ্যে সাবমিট করা হয়েছে।" });
    return;
  }

  const newDeposit = {
    id: "dep-" + Date.now(),
    userId: user.id,
    amount: Number(amount),
    bKashNumber,
    transactionId: transactionId.trim().toUpperCase(),
    status: "pending",
    createdAt: new Date().toISOString(),
    approvedAt: null,
    screenshot: screenshot || null
  };

  db.deposits.push(newDeposit);
  writeDB(db);

  res.json({ message: "ডিপোজিট রিকোয়েস্ট জমা দেওয়া হয়েছে! এডমিন শীঘ্রই ভেরিফাই করবেন।" });
});

// GET user notifications
app.get("/api/notifications", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const db = readDB();
  
  if (!db.notifications) {
    db.notifications = [];
  }

  // Admin gets global and admin notifications. Users get global and their own.
  const userNotifications = db.notifications.filter((n: any) => 
    n.userId === "all" || 
    n.userId === user.id || 
    (user.isAdmin && n.userId === "admin")
  );

  // Sort latest first
  userNotifications.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  res.json(userNotifications);
});

// Mark all user notifications as read
app.post("/api/notifications/mark-read", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const db = readDB();

  if (!db.notifications) {
    db.notifications = [];
  }

  db.notifications.forEach((n: any) => {
    if (n.userId === "all" || n.userId === user.id || (user.isAdmin && n.userId === "admin")) {
      n.isRead = true;
    }
  });

  writeDB(db);
  res.json({ success: true, message: "সকল নোটিফিকেশন পঠিত হিসেবে চিহ্নিত করা হয়েছে।" });
});

// Pipra Pay Initiate Payment Gateway
app.post("/api/payment/piprapay/initiate", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { amount } = req.body;

  const numAmount = Number(amount);
  if (!amount || isNaN(numAmount) || numAmount < 20) {
    res.status(400).json({ error: "সর্বনিম্ন ২০ টাকা পেমেন্ট করতে হবে।" });
    return;
  }

  const db = readDB();
  const transactionId = "PPY-" + Math.random().toString(36).substring(2, 8).toUpperCase() + Date.now().toString().slice(-4);
  const depositId = "dep-auto-" + Math.random().toString(36).substring(2, 9).toUpperCase();

  const newDeposit = {
    id: depositId,
    userId: user.id,
    amount: numAmount,
    bKashNumber: "Pipra Pay (অটোমেটিক)",
    transactionId,
    status: "pending",
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentType: "piprapay",
    screenshot: null
  };

  db.deposits.push(newDeposit);
  writeDB(db);

  // Return simulated/real redirect link
  const redirectUrl = `/checkout/piprapay?trxId=${transactionId}&amount=${numAmount}&depId=${depositId}`;
  
  res.json({
    success: true,
    redirectUrl,
    transactionId,
    depositId
  });
});

// Pipra Pay Callback Handler
app.post("/api/payment/piprapay/callback", authMiddleware, (req, res) => {
  const { transactionId, status } = req.body;
  
  if (!transactionId || !status) {
    res.status(400).json({ error: "লেনদেনের তথ্য অসম্পূর্ণ।" });
    return;
  }

  const db = readDB();
  const deposit = db.deposits.find((d: any) => d.transactionId === transactionId && d.paymentType === "piprapay");

  if (!deposit) {
    res.status(404).json({ error: "পেমেন্ট লেনদেনটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  if (deposit.status !== "pending") {
    res.json({ success: true, message: "পেমেন্ট ইতিমধ্যে প্রসেস করা হয়েছে।" });
    return;
  }

  if (status === "success") {
    const success = approveDepositInternal(db, deposit.id);
    if (success) {
      writeDB(db);
      res.json({ success: true, message: "পেমেন্ট সফলভাবে সম্পন্ন হয়েছে এবং ব্যালেন্স যুক্ত হয়েছে!" });
    } else {
      res.status(500).json({ error: "ডিপোজিট অ্যাপ্রুভ করতে সমস্যা হয়েছে।" });
    }
  } else {
    deposit.status = "rejected";
    writeDB(db);
    res.json({ success: false, message: "পেমেন্ট ব্যর্থ বা বাতিল হয়েছে।" });
  }
});

// Submit task
app.post("/api/task/submit", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { sheetLink, note, taskType } = req.body;

  if (!sheetLink) {
    res.status(400).json({ error: "গুগল শিট লিঙ্কটি আবশ্যিক।" });
    return;
  }

  const db = readDB();
  const newSubmission = {
    id: "sub-" + Date.now(),
    userId: user.id,
    sheetLink,
    note: note || "",
    status: "pending",
    createdAt: new Date().toISOString(),
    taskType: taskType || "2FA"
  };

  db.submissions.push(newSubmission);
  writeDB(db);

  res.json({ message: "কাজ সম্পন্ন হওয়ার গুগল শিট সফলভাবে জমা দেওয়া হয়েছে!" });
});

// Chat get & send
app.get("/api/chat/messages", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const db = readDB();
  const messages = db.chatMessages.filter((m: any) => m.userId === user.id);
  res.json(messages);
});

app.post("/api/chat/send", authMiddleware, async (req, res) => {
  const user = (req as any).user;
  const { message } = req.body;

  if (!message || message.trim() === "") {
    res.status(400).json({ error: "খালি মেসেজ পাঠানো সম্ভব নয়।" });
    return;
  }

  const db = readDB();
  const newMessage = {
    id: "chat-" + Date.now(),
    userId: user.id,
    sender: "user",
    message: message.trim(),
    createdAt: new Date().toISOString()
  };

  db.chatMessages.push(newMessage);
  writeDB(db);

  // Auto-trigger Gemini AI response in the same chat thread
  const apiKey = process.env.GEMINI_API_KEY || "AQ.Ab8RN6IlmdVQ-jR8x44D6L28x-2glY3wJ7jncy1u67eDFSTCUA";
  if (apiKey) {
    try {
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Get last 10 messages for context
      const chatHistory = db.chatMessages
        .filter((m: any) => m.userId === user.id)
        .slice(-10);

      const formattedContents: any[] = chatHistory.map((m: any) => ({
        role: m.sender === "user" ? "user" : "model",
        parts: [{ text: m.message }]
      }));

      const configText = JSON.stringify(db.config);
      const systemInstruction = `You are "RTN Support AI", an extremely polite, highly professional customer support AI chatbot for "RTN Premium Mail Store" (RTN প্রিমিয়াম মেইল স্টোর).
The store is owned and managed by Admin Ratan (রতন).

CRITICAL REQUIREMENT:
You MUST start your response with or clearly include the phrase: "আমি এআই সহকারী, আপনার সাধারণ প্রশ্নগুলোর উত্তর দেব। গুরুতর সমস্যা হলে অ্যাডমিন খুব দ্রুত মেসেজ দিয়ে সমাধান করবেন।" unless you have already stated this disclaimer in the last 2 turns of the dialogue history (to avoid being overly repetitive).

Store policies and details:
- Services: Premium verified email accounts (Outlook/Hotmail), Residential proxies, and AI services (ChatGPT, Gemini).
- 1-hour instant replacement warranty for any invalid accounts purchased!
- Tutorial videos are available directly on the homepage for creating hotmail accounts and setting up 2-Factor Authentication (2FA).
- Helpful Links: Two-Factor Generator is 2fa.cn, Token code checker is code.yamin.bd.
- Admin WhatsApp Support: ${db.config.adminWhatsApp || "8801609166109"}.
- Active Group Link: ${db.config.whatsappGroupLink || "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr"}.
- Current Store Configuration: ${configText}.

Behavior:
- Answer simple, general customer queries immediately (e.g., how to generate 2FA, how to buy, where to convert tokens to codes, group link, etc.).
- Keep your answers concise, clear, and extremely warm. Speak in beautiful, respectful Bengali (or natural English terms/Banglish where appropriate).
- If the user's issue is complex, serious, or relates to account errors, failed deposits, manual payments, or custom requests, politely reassure them that Admin Ratan has been notified of their query and will reply personally to solve it as soon as possible.`;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: formattedContents,
        config: {
          systemInstruction,
          temperature: 0.7,
        }
      });

      const reply = response.text || "দুঃখিত, আমি আপনার প্রশ্নটি বুঝতে পারিনি। অনুগ্রহ করে আবার চেষ্টা করুন।";
      
      // Save AI reply to the same unified message log
      const aiMessage = {
        id: "chat-ai-" + Date.now(),
        userId: user.id,
        sender: "admin",
        isAi: true,
        message: reply.trim(),
        createdAt: new Date().toISOString()
      };

      // Reload db to prevent overwrites, append and write
      const freshDb = readDB();
      freshDb.chatMessages.push(aiMessage);
      writeDB(freshDb);

    } catch (aiError) {
      console.error("AI automated reply generation failed:", aiError);
    }
  }

  res.json(newMessage);
});

// AI Customer Support Chatbot using Gemini API
app.post("/api/ai/chat", authMiddleware, async (req, res) => {
  const { message, history } = req.body;
  if (!message || message.trim() === "") {
    res.status(400).json({ error: "মেসেজ প্রদান করা আবশ্যক।" });
    return;
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY || "AQ.Ab8RN6IlmdVQ-jR8x44D6L28x-2glY3wJ7jncy1u67eDFSTCUA";
    if (!apiKey) {
      res.json({
        reply: "দুঃখিত, এআই চ্যাট অ্যাসিস্ট্যান্ট সচল করতে এডমিন প্যানেলে Gemini API Key সেট করতে হবে। অনুগ্রহ করে এডমিনের সাথে যোগাযোগ করুন।"
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    const db = readDB();
    const configText = JSON.stringify(db.config);
    
    const systemInstruction = `You are "RTN Support AI", an extremely polite, highly professional customer support AI chatbot for "RTN Premium Mail Store" (RTN প্রিমিয়াম মেইল স্টোর).
The store is owned and managed by Admin Ratan (রতন).
Store policies and details:
- Services: Premium verified email accounts (Outlook/Hotmail), Residential proxies, and AI services (ChatGPT, Gemini).
- 1-hour instant replacement warranty for any invalid accounts purchased!
- Tutorial videos are available directly on the homepage for creating hotmail accounts and setting up 2-Factor Authentication (2FA).
- Helpful Links: Two-Factor Generator is 2fa.cn, Token code checker is code.yamin.bd.
- Admin WhatsApp Support: ${db.config.adminWhatsApp || "8801609166109"}.
- Active Group Link: ${db.config.whatsappGroupLink || "https://chat.whatsapp.com/HyjYM2zc6mTBSOGa0xyWJr"}.
- Current Store Configuration: ${configText}.

Answer customer queries accurately, warmly, and helpfully. Speak primarily in beautiful Bengali (with occasional natural English terms) or Banglish, depending on the user's input style. Keep responses concise, avoiding long-winded paragraphs.`;

    const formattedContents: any[] = [];
    if (history && Array.isArray(history)) {
      history.forEach((h: any) => {
        formattedContents.push({
          role: h.role === "user" ? "user" : "model",
          parts: [{ text: h.text }]
        });
      });
    }
    formattedContents.push({
      role: "user",
      parts: [{ text: message.trim() }]
    });

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: formattedContents,
      config: {
        systemInstruction,
        temperature: 0.7,
      }
    });

    const reply = response.text || "দুঃখিত, আমি আপনার প্রশ্নটি বুঝতে পারিনি। অনুগ্রহ করে আবার চেষ্টা করুন।";
    res.json({ reply });
  } catch (error: any) {
    console.error("AI Chat Assistant error:", error);
    res.json({
      reply: "দুঃখিত, এআই প্রসেসিংয়ের সময় একটি সাময়িক ত্রুটি হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।"
    });
  }
});

// Helper for User Levels and Discounts based on spend
function getUserLevelAndDiscount(totalSpent: number) {
  if (totalSpent >= 15000) return { level: "Platinum", discountPercent: 5 }; // 5% discount
  if (totalSpent >= 5000) return { level: "Gold", discountPercent: 2 }; // 2% discount
  if (totalSpent >= 1000) return { level: "Silver", discountPercent: 1 }; // 1% discount
  return { level: "Bronze", discountPercent: 0 };
}

// User toggle favorite product
app.post("/api/user/favorite/toggle", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }
  const db = readDB();
  const dbUser = db.users.find((u: any) => u.id === user.id);
  if (!dbUser) {
    res.status(404).json({ error: "ইউজার পাওয়া যায়নি।" });
    return;
  }
  if (!dbUser.wishlist) dbUser.wishlist = [];
  const idx = dbUser.wishlist.indexOf(productId);
  if (idx > -1) {
    dbUser.wishlist.splice(idx, 1);
  } else {
    dbUser.wishlist.push(productId);
  }
  writeDB(db);
  res.json({ success: true, wishlist: dbUser.wishlist });
});

// User toggle stock alerts subscription
app.post("/api/user/stock-alert/toggle", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }
  const db = readDB();
  const dbUser = db.users.find((u: any) => u.id === user.id);
  if (!dbUser) {
    res.status(404).json({ error: "ইউজার পাওয়া যায়নি।" });
    return;
  }
  if (!dbUser.subscribedStockAlerts) dbUser.subscribedStockAlerts = [];
  const idx = dbUser.subscribedStockAlerts.indexOf(productId);
  if (idx > -1) {
    dbUser.subscribedStockAlerts.splice(idx, 1);
  } else {
    dbUser.subscribedStockAlerts.push(productId);
  }
  writeDB(db);
  res.json({ success: true, subscribedStockAlerts: dbUser.subscribedStockAlerts });
});

// User redeem loyalty points
app.post("/api/user/loyalty/redeem", authMiddleware, (req, res) => {
  const user = (req as any).user;
  const { points } = req.body;
  if (!points || points <= 0) {
    res.status(400).json({ error: "সঠিক লয়ালটি পয়েন্ট প্রদান করুন।" });
    return;
  }
  const db = readDB();
  const dbUser = db.users.find((u: any) => u.id === user.id);
  if (!dbUser) {
    res.status(404).json({ error: "ইউজার পাওয়া যায়নি।" });
    return;
  }
  const currentPoints = dbUser.loyaltyPoints || 0;
  if (currentPoints < points) {
    res.status(400).json({ error: "আপনার পর্যাপ্ত লয়ালটি পয়েন্ট নেই।" });
    return;
  }
  const rewardAmount = points; // 1 point = 1 Taka
  dbUser.loyaltyPoints = currentPoints - points;
  dbUser.balance = (dbUser.balance || 0) + rewardAmount;

  // Add notification
  const notificationsList = db.notifications || [];
  const notificationId = "notif-" + Math.random().toString(36).substring(2, 9);
  notificationsList.push({
    id: notificationId,
    userId: dbUser.id,
    title: "লয়ালটি পয়েন্ট রিডিম সফল! 💰",
    message: `প্রিয় গ্রাহক, আপনি সফলভাবে ${points} লয়ালটি পয়েন্ট রিডিম করে ৳${rewardAmount} ওয়ালেট ব্যালেন্স পেয়েছেন।`,
    type: "success",
    isRead: false,
    createdAt: new Date().toISOString()
  });
  db.notifications = notificationsList;

  writeDB(db);
  res.json({ success: true, newBalance: dbUser.balance, newPoints: dbUser.loyaltyPoints });
});


// -----------------------------------------------------------------------------
// Admin APIs (All routes below require Admin authorization)
// -----------------------------------------------------------------------------

// Get all deposits for Admin
app.get("/api/admin/deposits", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  res.json(db.deposits);
});

// Approve Deposit and award Referral Bonus
app.post("/api/admin/deposits/approve", authMiddleware, adminMiddleware, (req, res) => {
  const { depositId } = req.body;
  if (!depositId) {
    res.status(400).json({ error: "ডিপোজিট আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const success = approveDepositInternal(db, depositId);
  if (success) {
    writeDB(db);
    res.json({ message: "ডিপোজিট সফলভাবে অ্যাপ্রুভ করা হয়েছে এবং রেফারেল বোনাস (প্রযোজ্য ক্ষেত্রে) বিতরণ করা হয়েছে।" });
  } else {
    res.status(400).json({ error: "ডিপোজিটটি অনুমোদন করা সম্ভব হয়নি। সম্ভবত এটি পেন্ডিং নেই বা আইডি ভুল।" });
  }
});

// Reject Deposit
app.post("/api/admin/deposits/reject", authMiddleware, adminMiddleware, (req, res) => {
  const { depositId } = req.body;
  if (!depositId) {
    res.status(400).json({ error: "ডিপোজিট আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const depositIndex = db.deposits.findIndex((d: any) => d.id === depositId);
  if (depositIndex === -1) {
    res.status(404).json({ error: "ডিপোজিট রিকোয়েস্টটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  if (db.deposits[depositIndex].status !== "pending") {
    res.status(400).json({ error: "এই ডিপোজিট রিকোয়েস্টটি ইতিমধ্যে প্রক্রিয়াজাত করা হয়েছে।" });
    return;
  }

  db.deposits[depositIndex].status = "rejected";
  db.deposits[depositIndex].approvedAt = new Date().toISOString();

  writeDB(db);
  res.json({ message: "ডিপোজিট রিকোয়েস্ট রিজেক্ট করা হয়েছে।" });
});

// Get all submissions for Admin
app.get("/api/admin/submissions", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  res.json(db.submissions);
});

// Approve/Reject Task Submission
app.post("/api/admin/submissions/action", authMiddleware, adminMiddleware, (req, res) => {
  const { submissionId, status } = req.body; // status: 'approved' | 'rejected'
  if (!submissionId || !status) {
    res.status(400).json({ error: "সাবমিশন আইডি এবং স্ট্যাটাস প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const subIndex = db.submissions.findIndex((s: any) => s.id === submissionId);
  if (subIndex === -1) {
    res.status(404).json({ error: "কাজটির সাবমিশন রেকর্ড পাওয়া যায়নি।" });
    return;
  }

  db.submissions[subIndex].status = status;
  writeDB(db);

  res.json({ message: `কাজটির সাবমিশন সফলভাবে ${status === "approved" ? "অ্যাপ্রুভ" : "রিজেক্ট"} করা হয়েছে।` });
});

// Add new Product
app.post("/api/admin/products/add", authMiddleware, adminMiddleware, (req, res) => {
  const { name, description, price, googleSheetUrl } = req.body;
  if (!name || !price || price < 0) {
    res.status(400).json({ error: "পণ্যটির নাম এবং সঠিক মূল্য প্রদান করুন।" });
    return;
  }

  const db = readDB();
  const newProduct = {
    id: "prod-" + Date.now(),
    name,
    description: description || "",
    price: Number(price),
    googleSheetUrl: googleSheetUrl || "",
    stock: 0
  };

  db.products.push(newProduct);
  writeDB(db);

  res.json({ message: "নতুন পণ্য সফলভাবে যুক্ত করা হয়েছে!", product: newProduct });
});

// Delete Product
app.post("/api/admin/products/delete", authMiddleware, adminMiddleware, (req, res) => {
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  db.products = db.products.filter((p: any) => p.id !== productId);
  // Also remove unsold mails of this product
  db.mails = db.mails.filter((m: any) => !(m.productId === productId && !m.isSold));

  writeDB(db);
  res.json({ message: "পণ্যটি সফলভাবে মুছে ফেলা হয়েছে।" });
});

// Clone Product
app.post("/api/admin/products/clone", authMiddleware, adminMiddleware, (req, res) => {
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const originalProduct = db.products.find((p: any) => p.id === productId);
  if (!originalProduct) {
    res.status(404).json({ error: "মূল পণ্যটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  const clonedProduct = {
    ...originalProduct,
    id: "prod-" + Date.now(),
    name: originalProduct.name + " (Copy)",
    stock: 0 // New clone starts with 0 stock
  };

  db.products.push(clonedProduct);
  writeDB(db);

  res.json({ message: "পণ্যটি সফলভাবে ক্লোন করা হয়েছে!", product: clonedProduct });
});

// Bulk Delete Products
app.post("/api/admin/products/bulk-delete", authMiddleware, adminMiddleware, (req, res) => {
  const { productIds } = req.body;
  if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
    res.status(400).json({ error: "মুছে ফেলার জন্য অন্তত একটি পণ্য নির্বাচন করুন।" });
    return;
  }

  const db = readDB();
  db.products = db.products.filter((p: any) => !productIds.includes(p.id));
  db.mails = db.mails.filter((m: any) => !(productIds.includes(m.productId) && !m.isSold));

  writeDB(db);
  res.json({ message: `${productIds.length}টি পণ্য সফলভাবে মুছে ফেলা হয়েছে!` });
});

// Download System Backup
app.get("/api/admin/backup", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  res.setHeader('Content-disposition', 'attachment; filename=rtn_db_backup.json');
  res.setHeader('Content-type', 'application/json');
  res.send(JSON.stringify(db, null, 2));
});

// Cleanup Spam deposits & notices
app.post("/api/admin/cleanup-spam", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  const initialDeposits = db.deposits.length;
  // Keep only pending deposits from the last 30 days and approved/rejected from last 14 days
  const cutoffTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.deposits = db.deposits.filter((d: any) => {
    const dTime = new Date(d.createdAt).getTime();
    return d.status === "pending" || dTime > cutoffTime;
  });

  const deletedDeposits = initialDeposits - db.deposits.length;
  writeDB(db);

  res.json({ message: `সিস্টেম স্প্যাম ও পুরাতন ${deletedDeposits}টি ডিপোজিট রেকর্ড সফলভাবে ক্লিন করা হয়েছে!` });
});

// Update Product details
app.post("/api/admin/products/update", authMiddleware, adminMiddleware, (req, res) => {
  const { id, name, description, price, googleSheetUrl } = req.body;
  if (!id || !name || price === undefined || price < 0) {
    res.status(400).json({ error: "আইডি, পণ্যের নাম এবং সঠিক মূল্য প্রদান করুন।" });
    return;
  }

  const db = readDB();
  const prodIndex = db.products.findIndex((p: any) => p.id === id);
  if (prodIndex === -1) {
    res.status(404).json({ error: "পণ্যটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  db.products[prodIndex] = {
    ...db.products[prodIndex],
    name,
    description: description || "",
    price: Number(price),
    googleSheetUrl: googleSheetUrl !== undefined ? googleSheetUrl : db.products[prodIndex].googleSheetUrl
  };

  writeDB(db);
  res.json({ message: "পণ্যটি সফলভাবে আপডেট করা হয়েছে!", product: db.products[prodIndex] });
});

// Sync Product Mails from Google Sheet
app.post("/api/admin/products/sync-sheet", authMiddleware, adminMiddleware, async (req, res) => {
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }
  try {
    const addedCount = await syncMailsFromGoogleSheet(productId);
    res.json({ success: true, message: `গুগল শিট থেকে ${addedCount}টি মেইল সফলভাবে সিঙ্ক করা হয়েছে!` });
  } catch (err: any) {
    res.status(500).json({ error: `শিট সিঙ্ক করতে ব্যর্থ হয়েছে: ${err.message}` });
  }
});

// Clear all mails for a specific product
app.post("/api/admin/products/clear-mails", authMiddleware, adminMiddleware, (req, res) => {
  const { productId } = req.body;
  if (!productId) {
    res.status(400).json({ error: "পণ্য আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  db.mails = db.mails.filter((m: any) => m.productId !== productId);
  writeDB(db);
  res.json({ message: "পণ্যের সকল স্টক মেইল সফলভাবে মুছে ফেলা হয়েছে।" });
});

// Get all mails/stock details for admin (to show sold status, who bought, and allow deletion)
app.get("/api/admin/mails/all", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  const mailsWithInfo = db.mails.map((m: any) => {
    const prod = db.products.find((p: any) => p.id === m.productId);
    const soldToUser = db.users.find((u: any) => u.id === m.soldTo);
    return {
      ...m,
      productName: prod ? prod.name : "Unknown Product",
      soldToName: soldToUser ? (soldToUser.displayName || soldToUser.id) : null
    };
  });
  res.json(mailsWithInfo);
});

// Delete specific mail/credential item
app.post("/api/admin/mails/delete", authMiddleware, adminMiddleware, (req, res) => {
  const { mailId } = req.body;
  if (!mailId) {
    res.status(400).json({ error: "স্টক আইটেম আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  db.mails = db.mails.filter((m: any) => m.id !== mailId);
  writeDB(db);
  res.json({ message: "স্টক আইটেমটি সফলভাবে মুছে ফেলা হয়েছে।" });
});

// Upload Mails (Direct mail list upload)
app.post("/api/admin/mails/upload", authMiddleware, adminMiddleware, (req, res) => {
  const { productId, mailsList } = req.body; // mailsList is a string with newline separated emails
  if (!productId || !mailsList || mailsList.trim() === "") {
    res.status(400).json({ error: "পণ্য আইডি এবং মেইলের তালিকা প্রদান করুন।" });
    return;
  }

  const db = readDB();
  const productExists = db.products.some((p: any) => p.id === productId);
  if (!productExists) {
    res.status(404).json({ error: "পণ্যটি খুঁজে পাওয়া যায়নি।" });
    return;
  }

  const lines = mailsList.split("\n").map((line: string) => line.trim()).filter((line: string) => line !== "");
  const addedMails: any[] = [];

  for (const content of lines) {
    addedMails.push({
      id: "mail-" + Date.now() + "-" + Math.floor(Math.random() * 1000000),
      productId,
      content,
      isSold: false,
      soldTo: null,
      soldAt: null,
      createdAt: new Date().toISOString()
    });
  }

  db.mails.push(...addedMails);

  // Auto Stock Notification: Find users who subscribed to stock alerts or have it in wishlist
  const restockProduct = db.products.find((p: any) => p.id === productId);
  const restockProductName = restockProduct ? restockProduct.name : "পণ্য";
  db.users.forEach((u: any) => {
    const wantsAlert = u.subscribedStockAlerts && u.subscribedStockAlerts.includes(productId);
    const hasWishlist = u.wishlist && u.wishlist.includes(productId);
    if (wantsAlert || hasWishlist) {
      if (!db.notifications) db.notifications = [];
      db.notifications.push({
        id: "restock-alert-" + Date.now() + "-" + u.id,
        userId: u.id,
        title: "পণ্য রিস্টক হয়েছে! 📦",
        message: `প্রিয় গ্রাহক, আপনার পছন্দের পণ্য "${restockProductName}" এর স্টক আপডেট করা হয়েছে! এখন ${addedMails.length} টি নতুন মেইল স্টকে পাওয়া যাচ্ছে। এখনই কিনতে আমাদের স্টোরে ভিজিট করুন!`,
        type: "success",
        isRead: false,
        createdAt: new Date().toISOString()
      });
      // Clear alert subscription if it was a one-shot alert subscription
      if (wantsAlert) {
        u.subscribedStockAlerts = u.subscribedStockAlerts.filter((id: string) => id !== productId);
      }
    }
  });

  writeDB(db);

  res.json({ message: `${addedMails.length}টি মেইল সফলভাবে আপলোড করা হয়েছে!` });
});

// Update System Configuration
app.post("/api/admin/config/update", authMiddleware, adminMiddleware, (req, res) => {
  const { 
    referralBonusPercent, 
    bkashNumber, 
    tokenToCodeLink, 
    twoFactorCodeLink, 
    whatsappGroupLink, 
    adminWhatsApp, 
    developerWhatsApp, 
    isPipraPayEnabled,
    isMaintenanceMode,
    isAutomationWelcomeEnabled,
    isAutomationLowStockEnabled,
    isAutomationLowBalanceEnabled
  } = req.body;

  const db = readDB();
  db.config = {
    ...db.config,
    referralBonusPercent: referralBonusPercent !== undefined ? Number(referralBonusPercent) : db.config.referralBonusPercent,
    bkashNumber: bkashNumber || db.config.bkashNumber,
    tokenToCodeLink: tokenToCodeLink !== undefined ? tokenToCodeLink : db.config.tokenToCodeLink,
    twoFactorCodeLink: twoFactorCodeLink !== undefined ? twoFactorCodeLink : db.config.twoFactorCodeLink,
    whatsappGroupLink: whatsappGroupLink !== undefined ? whatsappGroupLink : db.config.whatsappGroupLink,
    adminWhatsApp: adminWhatsApp || db.config.adminWhatsApp,
    developerWhatsApp: developerWhatsApp || db.config.developerWhatsApp,
    isPipraPayEnabled: isPipraPayEnabled !== undefined ? Boolean(isPipraPayEnabled) : db.config.isPipraPayEnabled,
    isMaintenanceMode: isMaintenanceMode !== undefined ? Boolean(isMaintenanceMode) : db.config.isMaintenanceMode,
    isAutomationWelcomeEnabled: isAutomationWelcomeEnabled !== undefined ? Boolean(isAutomationWelcomeEnabled) : db.config.isAutomationWelcomeEnabled,
    isAutomationLowStockEnabled: isAutomationLowStockEnabled !== undefined ? Boolean(isAutomationLowStockEnabled) : db.config.isAutomationLowStockEnabled,
    isAutomationLowBalanceEnabled: isAutomationLowBalanceEnabled !== undefined ? Boolean(isAutomationLowBalanceEnabled) : db.config.isAutomationLowBalanceEnabled,
  };

  writeDB(db);
  res.json({ message: "কনফিগারেশন সফলভাবে আপডেট করা হয়েছে!", config: db.config });
});

// Update Notices
app.post("/api/admin/notice/update", authMiddleware, adminMiddleware, (req, res) => {
  const { content } = req.body;
  if (content === undefined) {
    res.status(400).json({ error: "নোটিশের কনটেন্ট প্রয়োজন।" });
    return;
  }

  const db = readDB();
  db.notices = [
    {
      id: "not-" + Date.now(),
      content: content,
      createdAt: new Date().toISOString()
    }
  ];

  writeDB(db);
  res.json({ message: "নোটিশ সফলভাবে আপডেট করা হয়েছে!" });
});

// Get all users for admin
app.get("/api/admin/users", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  const usersWithStats = db.users.map((u: any) => {
    const userPurchases = db.mails.filter((m: any) => m.soldTo === u.id);
    const userDeposits = db.deposits.filter((d: any) => d.userId === u.id && d.status === "approved");
    const referralsCount = db.users.filter((ref: any) => ref.referredBy === u.id).length;
    return {
      id: u.id,
      balance: u.balance,
      referredBy: u.referredBy,
      createdAt: u.createdAt,
      isBlocked: u.isBlocked,
      isAdmin: u.isAdmin,
      purchasesCount: userPurchases.length,
      totalDeposited: userDeposits.reduce((sum: number, d: any) => sum + d.amount, 0),
      referralsCount,
      displayName: u.displayName || "",
      avatarUrl: u.avatarUrl || "",
      rtnId: u.rtnId || "",
      bKashNumber: u.bKashNumber || "",
      whatsAppNumber: u.whatsAppNumber || "",
      email: u.email || "",
      isSuspended: !!u.isSuspended,
      isVerified: !!u.isVerified,
      role: u.role || 'support',
      lastLogin: u.lastLogin || "",
      loyaltyPoints: u.loyaltyPoints || 0
    };
  });
  res.json(usersWithStats);
});

// Block/Unblock user
app.post("/api/admin/users/toggle-block", authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "ব্যবহারকারী আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    res.status(404).json({ error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  if (db.users[userIndex].isAdmin) {
    res.status(400).json({ error: "এডমিন ব্যবহারকারীকে ব্লক করা সম্ভব নয়।" });
    return;
  }

  db.users[userIndex].isBlocked = !db.users[userIndex].isBlocked;
  writeDB(db);

  res.json({ message: `ব্যবহারকারীকে সফলভাবে ${db.users[userIndex].isBlocked ? "ব্লক" : "আনব্লক"} করা হয়েছে।` });
});

// Suspend/Unsuspend user
app.post("/api/admin/users/toggle-suspend", authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "ব্যবহারকারী আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    res.status(404).json({ error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  db.users[userIndex].isSuspended = !db.users[userIndex].isSuspended;
  writeDB(db);

  res.json({ message: `ব্যবহারকারীকে সফলভাবে ${db.users[userIndex].isSuspended ? "সাসপেন্ড" : "সাসপেনশন মুক্ত"} করা হয়েছে।` });
});

// Verify/Unverify user
app.post("/api/admin/users/toggle-verify", authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    res.status(400).json({ error: "ব্যবহারকারী আইডি প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    res.status(404).json({ error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  db.users[userIndex].isVerified = !db.users[userIndex].isVerified;
  writeDB(db);

  res.json({ message: `ব্যবহারকারীকে সফলভাবে ${db.users[userIndex].isVerified ? "ভেরিফাইড" : "আনভেরিফাইড"} করা হয়েছে।` });
});

// Update Admin Role
app.post("/api/admin/users/update-role", authMiddleware, adminMiddleware, (req, res) => {
  const { userId, role } = req.body;
  if (!userId || !role) {
    res.status(400).json({ error: "ব্যবহারকারী আইডি এবং রোল প্রয়োজন।" });
    return;
  }

  const db = readDB();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    res.status(404).json({ error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  db.users[userIndex].role = role;
  writeDB(db);

  res.json({ message: "ব্যবহারকারীর রোল সফলভাবে আপডেট করা হয়েছে!" });
});

// Update specific user balance
app.post("/api/admin/users/update-balance", authMiddleware, adminMiddleware, (req, res) => {
  const { userId, amount } = req.body;
  if (!userId || amount === undefined) {
    res.status(400).json({ error: "ব্যবহারকারী আইডি এবং ব্যালেন্সের পরিমাণ আবশ্যিক।" });
    return;
  }

  const db = readDB();
  const userIndex = db.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) {
    res.status(404).json({ error: "ব্যবহারকারী খুঁজে পাওয়া যায়নি।" });
    return;
  }

  db.users[userIndex].balance = Number(amount);
  writeDB(db);

  res.json({ message: "ব্যবহারকারীর ব্যালেন্স সফলভাবে আপডেট করা হয়েছে!" });
});

// Get users who have active chats
app.get("/api/admin/chat/users", authMiddleware, adminMiddleware, (req, res) => {
  const db = readDB();
  // Get unique userIds from chatMessages who are not admins
  const userIds = Array.from(new Set(db.chatMessages.map((m: any) => m.userId)));
  const usersWithChats = userIds.map((uid: string) => {
    const user = db.users.find((u: any) => u.id === uid);
    const lastMsg = db.chatMessages
      .filter((m: any) => m.userId === uid)
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return {
      id: uid,
      isAdmin: user ? user.isAdmin : false,
      lastMessage: lastMsg ? lastMsg.message : "",
      lastMessageAt: lastMsg ? lastMsg.createdAt : ""
    };
  }).filter(u => !u.isAdmin);

  res.json(usersWithChats);
});

// Get messages for a specific user chat
app.get("/api/admin/chat/messages/:userId", authMiddleware, adminMiddleware, (req, res) => {
  const { userId } = req.params;
  const db = readDB();
  const messages = db.chatMessages.filter((m: any) => m.userId === userId);
  res.json(messages);
});

// Admin sends message to user
app.post("/api/admin/chat/send", authMiddleware, adminMiddleware, (req, res) => {
  const { userId, message } = req.body;
  if (!userId || !message || message.trim() === "") {
    res.status(400).json({ error: "ব্যবহারকারী আইডি এবং মেসেজ আবশ্যিক।" });
    return;
  }

  const db = readDB();
  const newMessage = {
    id: "chat-" + Date.now(),
    userId: userId,
    sender: "admin",
    message: message.trim(),
    createdAt: new Date().toISOString()
  };

  db.chatMessages.push(newMessage);
  writeDB(db);

  res.json(newMessage);
});


// -----------------------------------------------------------------------------
// Vite and Static assets server
// -----------------------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}
