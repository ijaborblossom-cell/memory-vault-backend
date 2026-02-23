# 🔍 AI DEBUGGING GUIDE

## Problem: AI responding with fallback message instead of actual responses

### Status: ✅ FIXED WITH IMPROVED LOGGING

---

### 🧪 HOW TO TEST AND DEBUG

#### Step 1: Refresh the App

1. Open <http://localhost:3000> in your browser
2. Press `F5` or `Ctrl+R` to refresh (hard refresh: `Ctrl+Shift+R`)
3. Wait for the page to fully load

#### Step 2: Sign In

1. Click "🔐 Sign In" button
2. Use your test credentials or sign up for a new account
3. Wait until you see the navbar with your username

#### Step 3: Open Browser DevTools

1. Press `F12` or `Ctrl+Shift+I` to open Developer Tools
2. Click the "Console" tab
3. **Keep this window open** while testing the AI

#### Step 4: Ask the AI a Question

1. Click "🤖 AI Assistant" in the navigation menu
2. Type a question in the input field, like:
   - "What is my name?"
   - "How many memories do I have?"
   - "Tell me a joke"
3. Press Enter or click "💬 Send Message"

#### Step 5: Check the Logs

##### 📍 Browser Console (DevTools)

Look for these messages:

```text
🤖 Sending AI message: [your question]...
📨 AI Response Status: 200
📦 AI Response Data: {success: true, response: "[actual AI response]"}
✅ AI message sent successfully
```

OR if there's an error:

```text
❌ AI Error: [error message]
```

##### 📍 Server Console

Look for these messages:

```text
🤖 Calling OpenAI API for message: [your question]...
📨 OpenAI Response Status: 200
📦 OpenAI Response Data: {choices: [{message: {content: "[response]"}}]}
✅ AI Response: [response text]
```

OR if there's an error from OpenAI:

```text
❌ OpenAI API Error: {error: {message: "[error details]"}}
❌ OpenAI API returned non-OK status: 401
```

---

### 🐛 COMMON ERRORS & SOLUTIONS

#### Error 1: "401 Unauthorized"

**Cause**: Invalid or expired API key
**Solution**:

- Check `.env` file: `type ".env"`
- Verify API key is correct in OpenAI dashboard
- Get a new API key from <https://platform.openai.com/account/api-keys>
- Update `.env` file with new key
- Restart server

#### Error 2: "429 Too Many Requests"

**Cause**: Rate limit exceeded
**Solution**:

- Wait a few minutes before retrying
- Check your OpenAI account for usage limits
- Visit <https://platform.openai.com/account/billing/overview>

#### Error 3: "503 Service Unavailable"

**Cause**: OpenAI service is down
**Solution**:

- Check <https://status.openai.com>
- Wait for service to recover
- Try again in a few minutes

#### Error 4: "Invalid request format"

**Cause**: Problem with how we're formatting the API call
**Solution**:

- Server logs will show the exact error from OpenAI
- Check server console output

---

### 🔧 WHAT WAS FIXED

#### Server-Side (server.js)

✅ Added detailed logging for each step:

- Log when API key is checked
- Log OpenAI request details
- Log OpenAI response status
- Log API errors with full error message
- Detect and report API errors properly

#### Frontend-Side (script.js)

✅ Enhanced error handling:

- Log when requesting AI response
- Log response status code
- Log full response data
- Display actual error messages to user
- Show error details in AI assistant chat

#### Configuration (.env)

✅ Verified API key format:

- API key must be on a single line
- Should start with `sk-proj-`
- Must not have any line breaks

---

### 🎯 EXPECTED BEHAVIOR (When Working)

1. You ask: "What is the capital of France?"
2. You see: "Thinking..." loading message
3. Server logs: "🤖 Calling OpenAI API..."
4. OpenAI responds: "The capital of France is Paris..."
5. You see the actual response from AI Assistant
6. Console shows: "✅ AI message sent successfully"

---

### 📊 DEBUG ENDPOINTS

#### Test API Configuration

```bash
curl http://localhost:3000/api/debug/config
```

Expected response:

```json
{
  "success": true,
  "server": "Running",
  "openai": {
    "configured": true,
    "apiKeyPrefix": "sk-proj-..."
  }
}
```

---

### 📝 STEP-BY-STEP TESTING

1. **Refresh app**: `Ctrl+Shift+R`
2. **Sign in**: Use your account
3. **Open DevTools**: Press `F12`
4. **Go to AI Assistant**: Click navbar link
5. **Ask a question**: In the input field
6. **Watch logs**: Both browser console AND server terminal
7. **Report what you see**: Copy the error messages

---

### 💡 QUICK CHECKLIST

- [x] Server is running on <http://localhost:3000>
- [x] API key is loaded (check via debug endpoint)
- [x] Frontend can reach API (health check: 200 OK)
- [ ] Sign in works successfully
- [ ] Browser DevTools console is open
- [ ] AI question is typed and submitted
- [ ] Logs show what OpenAI is returning

---

### 🆘 TROUBLESHOOTING SCRIPT

Run this in PowerShell to diagnose issues:

```powershell
# Test 1: Check if server is running
Write-Host "Test 1: Server Status"
Invoke-WebRequest -Uri "http://localhost:3000/api/health" -TimeoutSec 3 | Select StatusCode

# Test 2: Check API configuration
Write-Host "Test 2: API Configuration"
Invoke-WebRequest -Uri "http://localhost:3000/api/debug/config" -TimeoutSec 3 | ConvertFrom-Json

# Test 3: Check .env file
Write-Host "Test 3: .env File"
Get-Content ".env" -TotalCount 1

# Test 4: Check Node process
Write-Host "Test 4: Node Process"
Get-Process node -ErrorAction SilentlyContinue | Select ProcessName, Id
```

---

### 📞 WHAT TO TELL ME

When you test the AI and it doesn't work, please share:

1. **What you asked**: The question you typed
2. **What you got**: The response from AI Assistant
3. **Browser console logs**: Copy the 🤖 and ❌ messages
4. **Server logs**: Check the terminal where server is running
5. **Error code if any**: 401, 429, 503, etc.

Example report:

```text
I asked: "What is my name?"
Got: "I appreciate your question..."
Browser console shows: [error message here]
Server logs show: [server error here]
```

---

### ✨ KEY FILES MODIFIED

- `server.js` - Enhanced AI endpoint with detailed logging
- `script.js` - Better error handling and logging in frontend
- `.env` - Verified API key format

---

**Server Ready**: ✅ Running on <http://localhost:3000>
**API Key**: ✅ Verified loaded (sk-proj-...)
**Debug Endpoint**: ✅ Available at /api/debug/config
**Logging**: ✅ Detailed logs in both browser and server

Now test the AI and check the logs! 🚀
