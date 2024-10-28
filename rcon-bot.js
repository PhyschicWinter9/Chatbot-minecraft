const { Rcon } = require('rcon-client');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require('fs');
const path = require('path');
const readline = require('readline');
require('dotenv').config();

// Load environment variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MINECRAFT_DIR = process.env.MINECRAFT_DIR;
const rconConfig = {
    host: process.env.RCON_HOST,
    port: parseInt(process.env.RCON_PORT),
    password: process.env.RCON_PASSWORD
};
const AUTO_MESSAGE_INTERVAL = parseInt(process.env.AUTO_MESSAGE_INTERVAL) || 7200000;
const DONATION_LINK = process.env.DONATION_LINK;

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Setup bot logging
const BOT_LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(BOT_LOGS_DIR)) {
    fs.mkdirSync(BOT_LOGS_DIR);
}

function getBotLogFileName() {
    const date = new Date();
    return path.join(BOT_LOGS_DIR, `bot_${date.toISOString().split('T')[0]}.log`);
}

function logToFile(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    
    fs.appendFileSync(getBotLogFileName(), logMessage);
    console.log(`\x1b[36m[${timestamp}]\x1b[0m ${message}`);
}

// Function to verify Gemini AI connectivity
async function checkGeminiConnection() {
    try {
        const prompt = "Hello, can you respond to this test message?";
        const result = await model.generateContent(prompt);
        const response = result.response.text();
        logToFile('🟢 Gemini AI connection test successful');
        logToFile(`📝 Test response: ${response}`);
    } catch (error) {
        logToFile(`🔴 Error connecting to Gemini AI: ${error.message}`);
        throw error;
    }
}

// Function to send a message to the Minecraft server via RCON
async function sendRconMessage(message) {
    try {
        const rcon = await Rcon.connect(rconConfig);
        await rcon.send(`say ${message}`);
        await rcon.end();
        logToFile(`📤 Message sent to Minecraft: ${message}`);
    } catch (error) {
        logToFile(`🔴 Error sending RCON message: ${error.message}`);
        throw error;
    }
}

// Function to ask Gemini AI and receive a response
async function askGemini(question) {
    try {
        logToFile(`📤 Sending question to Gemini AI: "${question}"`);
        const result = await model.generateContent(question);
        const answer = result.response.text();
        logToFile(`📥 Response from Gemini AI: "${answer}"`);
        return answer;
    } catch (error) {
        logToFile(`🔴 Error communicating with Gemini AI: ${error.message}`);
        return "Sorry, I cannot answer your question at this time.";
    }
}

// Function to handle chat from Minecraft
async function handleMinecraftChat(message, player) {
    try {
        logToFile(`👤 Processing request from player ${player}: "${message}"`);
        const response = await askGemini(message);
        const formattedResponse = `[To ${player}] ${response}`;
        await sendRconMessage(formattedResponse);
        logToFile(`✅ Successfully processed request from ${player}`);
    } catch (error) {
        logToFile(`🔴 Error handling chat: ${error.message}`);
    }
}

// Function to watch the Minecraft log file
async function watchMinecraftLog() {
    const logPath = path.join(MINECRAFT_DIR, 'logs', 'latest.log');
    
    // Verify Minecraft logs directory exists
    const minecraftLogsDir = path.dirname(logPath);
    if (!fs.existsSync(minecraftLogsDir)) {
        throw new Error(`Minecraft logs directory not found: ${minecraftLogsDir}`);
    }

    // Verify latest.log exists
    if (!fs.existsSync(logPath)) {
        throw new Error(`Minecraft latest.log not found: ${logPath}`);
    }

    let lastSize = fs.statSync(logPath).size;
    let fileStream = null;
    let rl = null;

    function setupFileReading() {
        // Close existing streams if they exist
        if (fileStream) fileStream.destroy();
        if (rl) rl.close();

        // Get current file size
        const currentSize = fs.statSync(logPath).size;

        // Create a readable stream starting from the last known position
        fileStream = fs.createReadStream(logPath, {
            encoding: 'utf8',
            start: lastSize
        });

        // Update last known size
        lastSize = currentSize;

        // Create readline interface
        rl = readline.createInterface({
            input: fileStream,
            crlfDelay: Infinity
        });

        // Process new lines
        rl.on('line', async (line) => {
            try {
                // Parse chat messages looking for !ask commands
                const chatRegex = /^\[\d{2}Oct\d{4} \d{2}:\d{2}:\d{2}\.\d{3}\] \[Server thread\/INFO\] \[net\.minecraft\.server\.MinecraftServer\/\]: <(\w+)> (!ask\s*.+)$/;
                const match = line.match(chatRegex);
                
                if (match) {
                    const [, player, command] = match;
                    const question = command.replace('!ask', '').trim();
                    
                    logToFile(`📥 Received message from ${player}: "${command}"`);
                    logToFile(`🎯 Extracted question: "${question}"`);
                    
                    await handleMinecraftChat(question, player);
                }
            } catch (error) {
                logToFile(`🔴 Error processing log line: ${error.message}`);
            }
        });

        fileStream.on('end', () => {
            setTimeout(checkForChanges, 1000);
        });
    }

    function checkForChanges() {
        try {
            const currentSize = fs.statSync(logPath).size;
            if (currentSize > lastSize) {
                setupFileReading();
            } else if (currentSize < lastSize) {
                lastSize = 0;
                setupFileReading();
            } else {
                setTimeout(checkForChanges, 1000);
            }
        } catch (error) {
            logToFile(`🔴 Error checking file changes: ${error.message}`);
            setTimeout(checkForChanges, 5000);
        }
    }

    const watcher = fs.watch(logPath, (eventType, filename) => {
        if (eventType === 'change') {
            checkForChanges();
        } else if (eventType === 'rename') {
            logToFile('📋 Detected log file rotation, reconnecting...');
            lastSize = 0;
            setTimeout(setupFileReading, 1000);
        }
    });

    watcher.on('error', (error) => {
        logToFile(`🔴 Watch error: ${error.message}`);
        watcher.close();
        setTimeout(() => watchMinecraftLog(), 5000);
    });

    setupFileReading();
    logToFile(`🔍 Watching Minecraft log file: ${logPath}`);
}

// Main function to start the bot
async function main() {
    try {
        // Verify required environment variables
        const requiredEnvVars = [
            { name: 'GEMINI_API_KEY', value: GEMINI_API_KEY },
            { name: 'MINECRAFT_DIR', value: MINECRAFT_DIR },
            { name: 'RCON_HOST', value: rconConfig.host },
            { name: 'RCON_PORT', value: rconConfig.port },
            { name: 'RCON_PASSWORD', value: rconConfig.password }
        ];

        for (const { name, value } of requiredEnvVars) {
            if (!value) {
                throw new Error(`Missing required environment variable: ${name}`);
            }
        }

        if (!fs.existsSync(MINECRAFT_DIR)) {
            throw new Error(`Minecraft directory not found: ${MINECRAFT_DIR}`);
        }

        logToFile('🚀 Starting Minecraft Chat Bot...');
        await checkGeminiConnection();
        logToFile('✅ Gemini AI connection established');

        await sendRconMessage('Chat bot system is now online! Use !ask to chat with Gemini AI');
        logToFile('🟢 Connected to Minecraft server');

        await watchMinecraftLog();
        logToFile('👀 Now watching Minecraft log file for commands');

        const autoMessage = `§6🌟 Support Our Server! 🚀 §bHelp us keep the fun going by donating at §l${DONATION_LINK}§b. Your support means a lot! Thank you for being part of our community! 🙏`;
        
        setInterval(() => {
            logToFile('⏰ Sending scheduled auto-message');
            sendRconMessage(autoMessage).catch(error => {
                logToFile(`🔴 Error sending auto-message: ${error.message}`);
            });
        }, AUTO_MESSAGE_INTERVAL);

        logToFile('✅ Bot initialization complete - Ready to process messages');
        logToFile(`ℹ️ Auto-message interval set to ${AUTO_MESSAGE_INTERVAL/1000/60} minutes`);
        logToFile(`📂 Minecraft directory: ${MINECRAFT_DIR}`);

    } catch (error) {
        logToFile(`🔴 Fatal error in main function: ${error.message}`);
        process.exit(1);
    }
}

// Handle process termination
process.on('SIGINT', () => {
    logToFile('👋 Bot shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logToFile(`🔴 Uncaught Exception: ${error.message}`);
    logToFile('👋 Bot shutting down due to uncaught exception...');
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logToFile(`🔴 Unhandled Promise Rejection at: ${promise}\n Reason: ${reason}`);
});

main().catch(error => {
    logToFile(`🔴 Unhandled error: ${error.message}`);
    process.exit(1);
});