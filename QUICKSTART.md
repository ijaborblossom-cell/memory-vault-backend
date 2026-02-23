# 🚀 Memory Vault - Quick Start Guide

## ⚡ Quickest Way to Start (3 Steps)

### Step 1: First Time Setup (One-time only)

**Double-click:** `setup.bat`

This will:

- ✓ Check Node.js installation
- ✓ Install all dependencies automatically
- ✓ Start the server
- ✓ Open in your browser

### Step 2: Running the Server Every Time

**Double-click:** `start.bat`

This will:

- ✓ Check for dependencies
- ✓ Start the server on http://localhost:3000
- ✓ Keep the window open (you'll see logs)

### Step 3: Open in Browser (Optional)

**Double-click:** `open.bat`

This will:

- ✓ Verify server is running
- ✓ Open the app in your default browser

---

## 📁 What Each File Does

| File                 | Purpose                        | Use When                    |
| -------------------- | ------------------------------ | --------------------------- |
| `setup.bat`          | Full installation + auto-start | First time or fresh install |
| `start.bat`          | Just start the server          | Running the app after setup |
| `open.bat`           | Open in browser                | Server already running      |
| `backend/server.js`          | Backend code                   | Reference/debugging         |
| `src/index.html` | Frontend code                  | Viewing HTML structure      |

---

## 🎯 Typical Workflow

```
1st Time:
└─ Double-click setup.bat
   └─ Wait for "Press any key to continue"
   └─ App opens automatically in browser
   └─ Done! 🎉

Every Other Time:
└─ Double-click start.bat
   └─ Server starts running
   └─ Open http://localhost:3000 in browser
   └─ Or double-click open.bat
```

---

## 🛑 How to Stop

**To stop the server:**

1. Click on the black command window (server window)
2. Press `Ctrl + C`
3. Type `Y` and press Enter
4. Window closes automatically

---

## ✅ Troubleshooting

### "Node is not installed"

**Solution:** Download from https://nodejs.org/ and install

### "Port 3000 is already in use"

**Solution:**

```bash
# Find and close the process using port 3000
netstat -ano | find ":3000"
# Note the PID number, then:
taskkill /PID [PID] /F
```

### "npm not found"

**Solution:** Restart your computer after installing Node.js

### "Cannot find page" after clicking open.bat

**Solution:** Make sure start.bat is running first

### Blank page in browser

**Solution:**

1. Press F12 to open Developer Tools
2. Click "Console" tab
3. Look for red error messages
4. Try clearing browser cache (Ctrl+Shift+Delete)

---

## 📊 System Information

- **Node.js required:** v14 or newer
- **Port used:** 3000
- **Memory footprint:** ~50-100 MB
- **Space needed:** ~200 MB (with node_modules)

---

## 🎉 You're Ready!

Just double-click `setup.bat` and you're done!

Everything will be installed and running automatically. 🚀

---

**Questions?** Check TESTING.md or README.md for more details.

