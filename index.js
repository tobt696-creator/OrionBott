const express = require("express");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials
} = require("discord.js");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ⭐ IMPORTANT: Let Railway choose the port
const PORT = process.env.PORT || 3000;
const mongoose = require("mongoose");
// ----------------------------------------------------
// DATA PERSISTENCE (Railway Volume)
// ----------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadJson(fileName, defaultValue) {
  const fullPath = path.join(DATA_DIR, fileName);
  try {
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, JSON.stringify(defaultValue, null, 2));
      return defaultValue;
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load ${fileName}:`, err);
    return defaultValue;
  }
}

function saveJson(fileName, data) {
  const fullPath = path.join(DATA_DIR, fileName);
  try {
    fs.writeFileSync(fullPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to save ${fileName}:`, err);
  }
}



mongoose.connect(process.env.MONGO_URI)
.then(() => {
  console.log("✅ MongoDB Connected");
}).catch(err => {
  console.error("❌ MongoDB Connection Error:", err);
});



// ----------------------------------------------------
// IN-MEMORY STORES (BACKED BY JSON)
// ----------------------------------------------------
let codeToUserId = loadJson("codes.json", {});          // codeToUserId["123456"] = "2010692028"
let linkedAccounts = loadJson("linked.json", {});       // linkedAccounts["2010692028"] = "1403467428255633428"
let discordToRoblox = {};
for (const [rbxId, dId] of Object.entries(linkedAccounts)) {
  discordToRoblox[String(dId).trim()] = String(rbxId).trim();
}

const productSchema = new mongoose.Schema({
  hub: { type: String, required: true },
  name: String,
  description: String,
  imageId: String,
  devProductId: { type: String, unique: true },
  fileName: String,
  fileDataBase64: String
}, { timestamps: true });


const Product = mongoose.model("Product", productSchema);
const ownedSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true }
  },
  { timestamps: true }
);

ownedSchema.index({ userId: 1, productId: 1 }, { unique: true });

const Owned = mongoose.model("Owned", ownedSchema);

// ----------------------------------------------------
// DISCORD BOT SETUP
// ----------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});
          

// OTHER PERSISTED STATE
let warns = loadJson("warns.json", {});                 // warns[userId] = [ { reason, mod }, ... ]
let lastNumberData = loadJson("counting.json", { lastNumber: 0 });
let lastNumber = lastNumberData.lastNumber || 0;

// ----------------------------------------------------
// BASIC STATUS ENDPOINT
// ----------------------------------------------------
app.get("/status", (req, res) => {
  res.json({ online: true });
});

async function getRobloxUsername(userId) {
  const url = `https://users.roblox.com/v1/users/${userId}`;
  const { data } = await axios.get(url);
  return data?.name || "Unknown";
}

async function getRobloxHeadshotUrl(userId) {
  const url = `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`;
  const { data } = await axios.get(url);

  // data.data is usually an array like [{ imageUrl, state, targetId, ... }]
  return data?.data?.[0]?.imageUrl || null;
}


app.post("/migrate/hub", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  const result = await Product.updateMany(
    { hub: { $exists: false } },
    { $set: { hub: "Orion" } }
  );

  res.json({ success: true, modified: result.modifiedCount });
});
// ----------------------------------------------------
// ROBLOX → BOT: CREATE CODE
// body: { userId: number, code: "123456" }
// ----------------------------------------------------
app.post("/createCode", (req, res) => {
  const { userId, code } = req.body;

  if (!userId || !code) {
    return res.json({ success: false, message: "Missing userId or code" });
  }

  codeToUserId[code] = String(userId);
  saveJson("codes.json", codeToUserId);

  console.log(`Saved code ${code} for userId ${userId}`);

  return res.json({ success: true });
});

// ----------------------------------------------------
// ROBLOX → BOT: CHECK LINKED DISCORD ACCOUNT
// GET /link/:userId
// ----------------------------------------------------
app.get("/link/:userId", (req, res) => {
  const userId = req.params.userId;
  const discordId = linkedAccounts[userId];

  if (!discordId) {
    return res.json({ linked: false });
  }

  return res.json({ linked: true, discordId });
});

// ----------------------------------------------------
// ⭐ ROBLOX ANNOUNCEMENT ENDPOINT
// ----------------------------------------------------
app.post("/announce", async (req, res) => {
  const { title, description } = req.body;

  if (!title || !description) {
    return res.json({ success: false, message: "Missing title or description" });
  }

  try {
    await axios.post(
      `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/AnnouncementEvent`,
      {
        message: JSON.stringify({ title, description })
      },
      {
        headers: {
          "x-api-key": process.env.ROBLOX_API_KEY
        }
      }
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("Announcement Relay Error:", err.response?.data || err);
    return res.json({ success: false, message: "Relay failed" });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: ADD PRODUCT (from Discord bot)
// body: { name, description, imageId, devProductId, fileName, fileData }
// ----------------------------------------------------
app.post("/addProduct", async (req, res) => {
  const { hub, name, description, imageId, devProductId, fileName, fileData } = req.body;

  if (!hub || !name || !description || !imageId || !devProductId || !fileName || !fileData) {
    return res.json({ success: false, message: "Missing product fields" });
  }

  // Optional: validate hub
function normalizeHub(h) {
  const clean = String(h || "").trim().toLowerCase();

  if (clean === "orion") return "Orion";
  if (clean === "nova lighting") return "Nova Lighting";
  if (clean === "sunlight solutions") return "Sunlight Solutions";

  return null;
}

const fixedHub = normalizeHub(hub);

if (!fixedHub) {
  return res.json({ success: false, message: "Invalid hub" });
}

  try {
    const existing = await Product.findOne({ devProductId: String(devProductId) });
    if (existing) {
      return res.json({ success: false, message: "DevProductId already exists" });
    }

    const product = new Product({
      hub: fixedHub,
      name,
      description,
      imageId,
      devProductId: String(devProductId),
      fileName,
      fileDataBase64: fileData
    });

    await product.save();
    return res.json({ success: true, productId: product._id });
  } catch (err) {
    console.error("AddProduct Error:", err);
    return res.json({ success: false });
  }
});


/// ----------------------------------------------------
// GET downtime state (Roblox can poll)
// ----------------------------------------------------
app.get("/downtime", async (req, res) => {
  try {
    const enabled = await getDowntimeEnabled();
    return res.json({ enabled });
  } catch (e) {
    console.error("GET /downtime error:", e);
    return res.status(500).json({ enabled: false });
  }
});

// ----------------------------------------------------
// SET downtime state (admin only) + broadcast to Roblox
// POST /downtime  body: { enabled: true/false }
// header: x-admin-key: <ADMIN_KEY>
// ----------------------------------------------------
app.post("/downtime", async (req, res) => {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const enabled = !!req.body?.enabled;

    const saved = await setDowntimeEnabled(enabled, "api");

    // Broadcast to Roblox live servers (Messaging Service)
    try {
      await axios.post(
        `https://apis.roblox.com/messaging-service/v1/universes/${process.env.UNIVERSE_ID}/topics/DowntimeEvent`,
        { message: JSON.stringify({ enabled: saved }) },
        { headers: { "x-api-key": process.env.ROBLOX_API_KEY } }
      );
    } catch (e) {
      console.error("Downtime broadcast failed:", e.response?.data || e);
    }

    return res.json({ success: true, enabled: saved });
  } catch (e) {
    console.error("POST /downtime error:", e);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});
// ----------------------------------------------------
// ⭐ PRODUCT API: REMOVE PRODUCT
// body: { productId }
// ----------------------------------------------------
app.post("/removeProduct", async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.json({ success: false, message: "Missing productId" });

  try {
    const deleted = await Product.findByIdAndDelete(productId);
    if (!deleted) return res.json({ success: false, message: "Invalid productId" });

    await Owned.deleteMany({ productId: new mongoose.Types.ObjectId(productId) });


    console.log("Product removed:", productId);
    return res.json({ success: true });
  } catch (err) {
    console.error("RemoveProduct Error:", err);
    return res.json({ success: false });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: LIST PRODUCTS (for Roblox UI)
// GET /products
// ----------------------------------------------------
app.get("/products", async (req, res) => {
  try {
    const products = await Product.find();

    const list = products.map(p => ({
      id: p._id,
      hub: p.hub, 
      name: p.name,
      description: p.description,
      imageId: p.imageId,
      devProductId: p.devProductId
    }));

    return res.json({ products: list });

  } catch (err) {
    console.error("Fetch Products Error:", err);
    return res.json({ products: [] });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: OWNED PRODUCTS (for Roblox UI)
// GET /owned/:userId
// ----------------------------------------------------
app.get("/owned/:userId", async (req, res) => {
  try {
    const userId = String(req.params.userId);
    const rows = await Owned.find({ userId }).select("productId");
    return res.json({ owned: rows.map(r => String(r.productId)) });
  } catch (err) {
    console.error("Owned fetch error:", err);
    return res.json({ owned: [] });
  }
});

// ----------------------------------------------------
// DOWNTIME STATE (MongoDB)
// ----------------------------------------------------
const downtimeSchema = new mongoose.Schema(
  {
    key: { type: String, unique: true, default: "global" },
    enabled: { type: Boolean, default: false },
    updatedBy: { type: String, default: "" }
  },
  { timestamps: true }
);

const Downtime = mongoose.model("Downtime", downtimeSchema);

async function getDowntimeEnabled() {
  const doc = await Downtime.findOne({ key: "global" }).lean();
  return !!doc?.enabled;
}

async function setDowntimeEnabled(enabled, updatedBy = "") {
  const doc = await Downtime.findOneAndUpdate(
    { key: "global" },
    { $set: { enabled: !!enabled, updatedBy } },
    { upsert: true, new: true }
  ).lean();

  return !!doc?.enabled;
}

// ----------------------------------------------------
// ⭐ WHITELIST CHECK (for Roblox Module)
// POST /whitelist/check
// body: { userId, devProductId }
// ----------------------------------------------------
app.post("/whitelist/check", async (req, res) => {
  const { userId, devProductId } = req.body;

  if (!userId || !devProductId) {
    return res.json({ success: false, allowed: false, message: "Missing fields" });
  }

  try {
    // Find the product by devProductId
    const product = await Product.findOne({ devProductId: String(devProductId) });
    if (!product) {
      return res.json({ success: true, allowed: false, message: "Unknown product" });
    }

const ownedRow = await Owned.findOne({
  userId: String(userId),
  productId: product._id
}).select("_id");

const allowed = !!ownedRow;


    return res.json({
      success: true,
      allowed,
      product: allowed
        ? {
            id: String(product._id),
            name: product.name,
            devProductId: product.devProductId
          }
        : null
    });
  } catch (err) {
    console.error("Whitelist check error:", err);
    return res.json({ success: false, allowed: false, message: "Server error" });
  }
});

// ----------------------------------------------------
// ⭐ PRODUCT API: PURCHASE (from Roblox)
// body: { userId, devProductId }
// CLEANED + FIXED VERSION
// ----------------------------------------------------
app.post("/purchase", async (req, res) => {
  const { userId, devProductId } = req.body;

  if (!userId || !devProductId) {
    return res.json({ success: false, message: "Missing fields" });
  }

  try {
    // 1. Find product
    const product = await Product.findOne({
      devProductId: String(devProductId)
    });

    if (!product) {
      return res.json({ success: false, message: "Unknown product" });
    }

    // 2. Get linked Discord ID
    const discordId = linkedAccounts[userId];
    if (!discordId) {
      return res.json({ success: false, message: "User not linked" });
    }

    // 3. Fetch Discord user (USING EXISTING CLIENT)
    const user = await client.users.fetch(discordId);

// 4. Save ownership in Mongo
await Owned.updateOne(
  { userId: String(userId), productId: product._id },
  { $setOnInsert: { userId: String(userId), productId: product._id } },
  { upsert: true }
);


    // 5. Send DM
    const fileBuffer = Buffer.from(product.fileDataBase64, "base64");

    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🎁 Purchase Delivered`)
          .setDescription(product.description)
          .setColor(0x00ffea)
      ],
      files: [{
        attachment: fileBuffer,
        name: product.fileName
      }]
    });

    return res.json({ success: true });

  } catch (err) {
    console.error("Purchase error:", err);
    return res.json({
      success: false,
      message: "Delivery failed"
    });
  }
});


// ⭐ START WEB SERVER (Railway-compatible)
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});



// CHANNEL IDS
const MODMAIL_CHANNEL = "1466828764184051944";
const LOG_CHANNEL = "1403467428255633428";
const WELCOME_CHANNEL = "1443713535887806616";
const COUNTING_CHANNEL = "1452063879776436297";
const REVIEW_CHANNEL = "1450909512520175668";

// ----------------------------------------------------
// LOG HELPER
// ----------------------------------------------------
async function sendLog(guild, embed) {
  try {
    const channel = guild.channels.cache.get(LOG_CHANNEL);
    if (channel) await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Log Error:", err);
  }
}

client.on("clientReady", () => {
  console.log(`🤖 Bot online as ${client.user.tag}`);
  console.log("Restarted at:", new Date().toLocaleString());
  client.user.setActivity("Monitoring Orion", { type: 3 });
});

// ----------------------------------------------------
// WELCOME SYSTEM
// ----------------------------------------------------
client.on("guildMemberAdd", async (member) => {
  const welcomeChannel = member.guild.channels.cache.get(WELCOME_CHANNEL);
  if (welcomeChannel) {
    const embed = new EmbedBuilder()
      .setTitle("👋 Welcome to Orion!")
      .setDescription(`Welcome <@${member.id}> to the server!`)
      .setColor(0x00ffea)
      .setThumbnail(member.user.displayAvatarURL())
      .setTimestamp();

    welcomeChannel.send({ embeds: [embed] });
  }

  sendLog(
    member.guild,
    new EmbedBuilder()
      .setTitle("📥 Member Joined")
      .setDescription(`${member.user.tag} joined the server.`)
      .setColor(0x00ffea)
      .setTimestamp()
  );
});

// ----------------------------------------------------
// MODMAIL (DM → STAFF CHANNEL)
// ----------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.guild) return;
  if (message.author.bot) return;

  try {
    const channel = await client.channels.fetch(MODMAIL_CHANNEL);
    if (!channel) return;

    const embed = new EmbedBuilder()
      .setTitle("📩 New Modmail Message")
      .setDescription(message.content || "*No content*")
      .addFields({ name: "From", value: `${message.author.tag} (${message.author.id})` })
      .setColor(0x00aaff)
      .setTimestamp();

    channel.send({ embeds: [embed] });
  } catch (err) {
    console.error("Modmail Error:", err);
  }
});

// ----------------------------------------------------
// GUILD MESSAGE HANDLER
// ----------------------------------------------------
client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  if (message.author.bot) return;

  const args = message.content.trim().split(/\s+/);
  const cmd = args[0].toLowerCase();

  // ----------------------------------------------------
  // COUNTING SYSTEM
  // ----------------------------------------------------
  if (message.channel.id === COUNTING_CHANNEL) {
    const num = parseInt(message.content);

    if (isNaN(num) || num !== lastNumber + 1) {
      message.delete().catch(() => {});
      return;
    }

    lastNumber = num;
    lastNumberData.lastNumber = lastNumber;
    saveJson("counting.json", lastNumberData);

    return;
  }

  // ----------------------------------------------------
  // AUTO-MOD (EXAMPLE)
// ----------------------------------------------------
  const badWords = ["fuck", "shit","bitch"];

  if (badWords.some(w => message.content.toLowerCase().includes(w))) {
    try { await message.delete(); } catch {}

    message.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🛡️ Auto-Moderation")
          .setDescription(`${message.author}, that word is not allowed.`)
          .setColor(0xff0000)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🛡️ Auto-Mod Triggered")
        .setDescription(`${message.author.tag} used a blocked word.`)
        .setColor(0xff0000)
        .setTimestamp()
    );
  }
// ----------------------------------------------------
// PUBLIC COMMANDS
// ----------------------------------------------------
// profile
// ⭐ !Profile (supports !profile and !profile @user)
if (cmd === "!profile") {
  // If they mentioned someone, use that. Otherwise use the author.
  const targetUser = message.mentions.users.first() || message.author;

  const discordId = String(targetUser.id).trim();

  // Use your reverse map (recommended)
  const robloxUserId = discordToRoblox[discordId];

  if (!robloxUserId) {
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔗 Not Linked")
          .setDescription(
            targetUser.id === message.author.id
              ? "Your Discord isn’t linked to a Roblox account yet.\nUse `!pverify <code>` to link."
              : `${targetUser.tag} is not linked to a Roblox account.`
          )
          .setColor(0xff0000)
      ]
    });
  }

  // Fetch Roblox username + avatar
  let robloxName = "Unknown";
  let headshotUrl = null;

  try {
    robloxName = await getRobloxUsername(robloxUserId);
    headshotUrl = await getRobloxHeadshotUrl(robloxUserId);
  } catch (e) {
    console.error("Profile Roblox fetch error:", e);
  }

  // Owned products (keyed by Roblox userId)
 const ownedRows = await Owned.find({ userId: String(robloxUserId) }).select("productId");
const ownedIds = ownedRows.map(r => String(r.productId));


  let productLines = [];
  try {
    if (ownedIds.length > 0) {
      const products = await Product.find({ _id: { $in: ownedIds } });

      const byId = new Map(products.map(p => [String(p._id), p]));
      productLines = ownedIds
        .map(id => byId.get(String(id)))
        .filter(Boolean)
        .map(p => `• **${p.name}**`);
    }
  } catch (e) {
    console.error("Profile product fetch error:", e);
  }

  const embed = new EmbedBuilder()
    .setTitle("🧾 Profile")
    .setColor(0x00ffea)
    .addFields(
      { name: "Discord", value: `<@${discordId}> (\`${discordId}\`)`, inline: false },
      { name: "Roblox", value: `**${robloxName}** (\`${robloxUserId}\`)`, inline: false },
      {
        name: "🛒 Here are the products they own",
        value: productLines.length ? productLines.join("\n") : "*No products owned yet.*",
        inline: false
      }
    )
    .setTimestamp();

  if (headshotUrl) embed.setThumbnail(headshotUrl);

  return message.reply({ embeds: [embed] });
}



  // ⭐ !Commands
  if (cmd === "!commands") {
    const embed = new EmbedBuilder()
      .setTitle("📜 OrionBot Commands")
      .setColor(0x00ffea)
      .addFields(
        {
          name: "👥 Public Commands",
          value:
            "`!pverify <code>` – Link Roblox account\n" +
            "`!review <text>` – Submit a review\n" +
            "`!coinflip` – Flip a coin\n" +
            "`!profile [@user]` – View profile and owned products" 
        },
        {
          name: "🛡️ Staff Commands",
          value:
            "`!kick @user`\n" +
            "`!ban @user`\n" +
            "`!warn @user <reason>`\n" +
            "`!admindm @user <message>`\n" +
            "`!embed Title | Description | #Color`\n" +
            "`!giveaway <seconds> <prize>`\n" +
            "`!resetverify <RobloxUserId>`\n" +
            "`!addproduct` – Create a shop product\n" +
            "`!removeproduct` – Remove a shop product\n" +
            "`!downtime` – Puts the game on downtime\n" +
            "`!undowntime` – Removes downtime\n"
        },
        {
          name: "📢 Roblox Integration",
          value:
            "`!rblxannounce` – Send an announcement to the Roblox game"
        }
      )
      .setFooter({ text: "OrionBot • All systems operational" })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ⭐ !PVerify <6-digit-code>
  if (cmd === "!pverify") {
    const code = args[1];

    if (!code) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Missing Code")
            .setDescription("Please provide your 6-digit verification code.")
            .setColor(0xff0000)
        ]
      });
    }

    const userId = codeToUserId[code];

    if (!userId) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Code")
            .setDescription("That code is invalid or expired.")
            .setColor(0xff0000)
        ]
      });
    }

    const discordId = message.author.id;
    linkedAccounts[userId] = discordId;
    discordToRoblox[String(discordId).trim()] = String(userId).trim();
    delete codeToUserId[code];

    saveJson("linked.json", linkedAccounts);
    saveJson("codes.json", codeToUserId);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Verified & Linked")
          .setDescription(
            `Linked Roblox user **${userId}** to Discord user <@${discordId}>.\n` +
            `Roblox can now see your Discord account.`
          )
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("✅ Verification Linked")
        .setDescription(
          `Roblox user **${userId}** linked to Discord user **${message.author.tag}** (${discordId}).`
        )
        .setColor(0x00ff00)
        .setTimestamp()
    );

    return;
  }


  // ⭐ !Review <text>
  if (cmd === "!review") {
    const reviewText = args.slice(1).join(" ");

    if (!reviewText) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Missing Review")
            .setDescription("Please type your review after the command.")
            .setColor(0xff0000)
        ]
      });
    }

    const reviewChannel = message.guild.channels.cache.get(REVIEW_CHANNEL);
    if (!reviewChannel) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Review channel not found.")
            .setColor(0xff0000)
        ]
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("⭐ New Review Submitted")
      .setDescription(reviewText)
      .addFields({ name: "From", value: `${message.author.tag}` })
      .setColor(0x00ffea)
      .setTimestamp()
      .setThumbnail(message.author.displayAvatarURL());

    reviewChannel.send({ embeds: [embed] });

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Review Submitted")
          .setDescription("Thank you for your feedback!")
          .setColor(0x00ff00)
      ]
    });

    return;
  }

  // ⭐ !Coinflip
  if (cmd === "!coinflip") {
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    return message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🪙 Coinflip")
          .setDescription(result)
          .setColor(0x00ffea)
      ]
    });
  }

  // ----------------------------------------------------
  // ADMIN COMMANDS
  // ----------------------------------------------------
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

// ⭐ !addproduct
if (cmd === "!addproduct") {
  const dm = await message.author.send({
    embeds: [
      new EmbedBuilder()
        .setTitle("🛒 Add New Product")
        .setDescription("I'll ask you for product details. Reply within 60 seconds for each step.")
        .setColor(0x00ffea)
    ]
  }).catch(() => null);

  if (!dm) {
    return message.reply("I couldn't DM you. Please enable DMs and try again.");
  }

const HUBS = ["Orion", "Nova Lighting", "Sunlight Solutions"];

function detectHub(text) {
  const clean = String(text || "").trim().toLowerCase();

  if (clean === "orion") return "Orion";
  if (clean === "nova lighting") return "Nova Lighting";
  if (clean === "sunlight solutions") return "Sunlight Solutions";

  return null;
}

  const ask = async (question) => {
    await dm.channel.send({
      embeds: [new EmbedBuilder().setDescription(question).setColor(0x00ffea)]
    });

    const collected = await dm.channel.awaitMessages({
      filter: m => m.author.id === message.author.id,
      max: 1,
      time: 60000
    });

    if (!collected.size) return null;
    return collected.first();
  };

  // 1) Hub first
const hubMsg = await ask(
  "Type EXACTLY one of these hub names:\n" +
  "`Orion`\n" +
  "`Nova Lighting`\n" +
  "`Sunlight Solutions`"
);
  if (!hubMsg) return dm.channel.send("⏳ Timed out.");

  let hub = detectHub(hubMsg.content);

  let tries = 0;
  while (!hub && tries < 2) {
    tries++;
    const retry = await ask(`I did not catch that. Pick one: ${HUBS.join(", ")}.`);
    if (!retry) return dm.channel.send("⏳ Timed out.");
    hub = detectHub(retry.content);
  }

  if (!hub) return dm.channel.send("❌ Cancelled. Hub not selected.");

  // 2) Product fields
  const nameMsg = await ask("What is the **Product Name**?");
  if (!nameMsg) return dm.channel.send("⏳ Timed out.");
  const productName = nameMsg.content;

  const descMsg = await ask("What is the **Product Description**?");
  if (!descMsg) return dm.channel.send("⏳ Timed out.");
  const productDescription = descMsg.content;

  const imgMsg = await ask("What is the **Product Image ID**? (Roblox asset ID)");
  if (!imgMsg) return dm.channel.send("⏳ Timed out.");
  const imageId = imgMsg.content;

  const devMsg = await ask("What is the **Developer Product ID**?");
  if (!devMsg) return dm.channel.send("⏳ Timed out.");
  const devProductId = devMsg.content;

  // 3) File upload
  await dm.channel.send({
    embeds: [
      new EmbedBuilder()
        .setDescription("Please upload the **file** that buyers will receive.")
        .setColor(0x00ffea)
    ]
  });

  const fileCollected = await dm.channel.awaitMessages({
    filter: m => m.author.id === message.author.id && m.attachments.size > 0,
    max: 1,
    time: 60000
  });

  if (!fileCollected.size) {
    return dm.channel.send("⏳ Timed out. No file received.");
  }

  const file = fileCollected.first().attachments.first();
  const fileBuffer = await axios.get(file.url, { responseType: "arraybuffer" }).then(r => r.data);

  try {
const res = await axios.post(
  "https://orionbot-production.up.railway.app/addProduct",
  {
    hub: hub,
    name: productName,
    description: productDescription,
    imageId,
    devProductId,
    fileName: file.name,
    fileData: Buffer.from(fileBuffer).toString("base64")
  }
);

if (!res.data?.success) {
  console.error("AddProduct rejected:", res.data);
  return dm.channel.send(
    `❌ Failed: ${res.data?.message || "Unknown error"}`
  );
}

    dm.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("✅ Product Added")
          .setDescription(`**${productName}** added to **${hub}**.`)
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🛒 Product Added")
        .setDescription(`Product **${productName}** created by ${message.author.tag}.`)
        .setColor(0x00ffea)
        .setTimestamp()
    );
  } catch (err) {
    console.error("AddProduct Error:", err);
    dm.channel.send("❌ Failed to save product. Check server logs.");
  }

  return;
}



// ⭐ !downtime
if (cmd === "!downtime") {
  try {
    const res = await axios.post(
      "https://orionbot-production.up.railway.app/downtime",
      { enabled: true },
      { headers: { "x-admin-key": process.env.ADMIN_KEY } }
    );

    if (!res.data?.success) {
      console.error("!downtime rejected:", res.data);
      return message.reply("❌ Failed to enable downtime.");
    }

    return message.reply("🛠️ Downtime enabled.");
  } catch (err) {
    console.error("!downtime error:", err.response?.data || err);
    return message.reply("❌ Error enabling downtime. Check Railway logs.");
  }
}

// ⭐ !undowntime
if (cmd === "!undowntime") {
  try {
    const res = await axios.post(
      "https://orionbot-production.up.railway.app/downtime",
      { enabled: false },
      { headers: { "x-admin-key": process.env.ADMIN_KEY } }
    );

    if (!res.data?.success) {
      console.error("!undowntime rejected:", res.data);
      return message.reply("❌ Failed to disable downtime.");
    }

    return message.reply("✅ Downtime disabled.");
  } catch (err) {
    console.error("!undowntime error:", err.response?.data || err);
    return message.reply("❌ Error disabling downtime. Check Railway logs.");
  }
}

  // ⭐ !removeproduct
  if (cmd === "!removeproduct") {
    const dm = await message.author.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("🗑 Remove Product")
          .setDescription("I'll show you the current products. Reply with the **Product ID** to remove.")
          .setColor(0xffaa00)
      ]
    }).catch(() => null);

    if (!dm) {
      return message.reply("I couldn't DM you. Please enable DMs and try again.");
    }

    // Fetch current products from API
    let list = [];
    try {
      const res = await axios.get("https://orionbot-production.up.railway.app/products");
      list = res.data.products || [];
    } catch (err) {
      console.error("Fetch products error:", err);
      return dm.channel.send("❌ Failed to fetch products.");
    }

    if (list.length === 0) {
      return dm.channel.send("There are currently no products.");
    }

   let desc = list.map(p =>
  `**ID:** ${p.id}\n**Hub:** ${p.hub || "Unknown"}\n**Name:** ${p.name}\n**DevProductId:** ${p.devProductId}`
).join("\n\n");

    await dm.channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle("Current Products")
          .setDescription(desc)
          .setColor(0x00ffea)
      ]
    });

    const askIdMsg = await dm.channel.awaitMessages({
      filter: m => m.author.id === message.author.id,
      max: 1,
      time: 60000
    });

    if (!askIdMsg.size) {
      return dm.channel.send("⏳ Timed out.");
    }

    const productId = askIdMsg.first().content.trim();

    try {
      const res = await axios.post("https://orionbot-production.up.railway.app/removeProduct", {
        productId
      });

      if (!res.data.success) {
        return dm.channel.send("❌ Failed to remove product. Check ID.");
      }

      dm.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Product Removed")
            .setDescription(`Product with ID **${productId}** has been removed.`)
            .setColor(0x00ff00)
        ]
      });

      sendLog(
        message.guild,
        new EmbedBuilder()
          .setTitle("🗑 Product Removed")
          .setDescription(`Product ID **${productId}** removed by ${message.author.tag}.`)
          .setColor(0xffaa00)
          .setTimestamp()
      );

    } catch (err) {
      console.error("RemoveProduct Error:", err);
      dm.channel.send("❌ Failed to remove product. Check server logs.");
    }

    return;
  }

  // ⭐ !ResetVerify <RobloxUserId>
  if (cmd === "!resetverify") {
    const userId = args[1];

    if (!userId || isNaN(userId)) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid UserId")
            .setDescription("Please provide a valid Roblox UserId.")
            .setColor(0xff0000)
        ]
      });
    }

    delete linkedAccounts[userId];
    for (const code in codeToUserId) {
      if (codeToUserId[code] === String(userId)) {
        delete codeToUserId[code];
      }
    }

    saveJson("linked.json", linkedAccounts);
    saveJson("codes.json", codeToUserId);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("♻️ Verification Reset")
          .setDescription(`Verification/link reset for Roblox user **${userId}**.`)
          .setColor(0x00ff00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("♻️ Verification Reset Logged")
        .setDescription(
          `Verification/link reset for Roblox user **${userId}** by ${message.author.tag}.`
        )
        .setColor(0x00ff00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Kick
  if (cmd === "!kick") {
    const member = message.mentions.members.first();
    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to kick.")
            .setColor(0xff0000)
        ]
      });
    }

    await member.kick();

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("👢 Kicked")
          .setDescription(`Kicked ${member.user.tag}`)
          .setColor(0xffaa00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("👢 Kick Logged")
        .setDescription(`${member.user.tag} was kicked by ${message.author.tag}`)
        .setColor(0xffaa00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Ban
  if (cmd === "!ban") {
    const member = message.mentions.members.first();
    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to ban.")
            .setColor(0xff0000)
        ]
      });
    }

    await member.ban();

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🔨 Banned")
          .setDescription(`Banned ${member.user.tag}`)
          .setColor(0xff0000)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("🔨 Ban Logged")
        .setDescription(`${member.user.tag} was banned by ${message.author.tag}`)
        .setColor(0xff0000)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Warn
  if (cmd === "!warn") {
    const member = message.mentions.members.first();
    const reason = args.slice(2).join(" ") || "No reason";

    if (!member) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Mention someone to warn.")
            .setColor(0xff0000)
        ]
      });
    }

    if (!warns[member.id]) warns[member.id] = [];
    warns[member.id].push({ reason, mod: message.author.id });
    saveJson("warns.json", warns);

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️ Warned")
          .setDescription(`Warned ${member.user.tag}\n**Reason:** ${reason}`)
          .setColor(0xffcc00)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("⚠️ Warning Logged")
        .setDescription(
          `${member.user.tag} was warned by ${message.author.tag}\n**Reason:** ${reason}`
        )
        .setColor(0xffcc00)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !AdminDM
  if (cmd === "!admindm") {
    const member = message.mentions.members.first();
    const msg = args.slice(2).join(" ");

    if (!member || !msg) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Usage: !admindm @user <message>")
            .setColor(0xff0000)
        ]
      });
    }

    member.send(msg).catch(() => {});

    message.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("📨 Sent")
          .setDescription(`Message sent to ${member.user.tag}`)
          .setColor(0x00ffea)
      ]
    });

    sendLog(
      message.guild,
      new EmbedBuilder()
        .setTitle("📨 Admin DM Sent")
        .setDescription(
          `**To:** ${member.user.tag}\n**From:** ${message.author.tag}\n**Message:** ${msg}`
        )
        .setColor(0x00ffea)
        .setTimestamp()
    );

    return;
  }

  // ⭐ !Embed
  if (cmd === "!embed") {
    const content = args.slice(1).join(" ");
    if (!content.includes("|")) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Format")
            .setDescription("Use: `!embed Title | Description | #Color`")
            .setColor(0xff0000)
        ]
      });
    }

    const [title, description, color] = content.split("|").map(x => x.trim());

    const embed = new EmbedBuilder()
      .setTitle(title || " ")
      .setDescription(description || " ")
      .setColor(color || "#00ffea")
      .setTimestamp();

    message.delete().catch(() => {});
    message.channel.send({ embeds: [embed] });

    return;
  }

  // ⭐ !Giveaway
  if (cmd === "!giveaway") {
    const duration = parseInt(args[1]);
    const prize = args.slice(2).join(" ");

    if (!duration || !prize) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Error")
            .setDescription("Usage: !giveaway <seconds> <prize>")
            .setColor(0xff0000)
        ]
      });
    }

    const embed = new EmbedBuilder()
      .setTitle("🎉 Giveaway!")
      .setDescription(`Prize: **${prize}**\nReact with 🎉 to enter!`)
      .setColor(0x00ffea);

    const msg = await message.channel.send({ embeds: [embed] });
    await msg.react("🎉");

    setTimeout(async () => {
      try {
        const reaction = msg.reactions.cache.get("🎉");
        if (!reaction) return message.channel.send("No reactions found.");

        const users = await reaction.users.fetch();
        const entries = users.filter(u => !u.bot);

        if (entries.size === 0) {
          return message.channel.send("No valid entries.");
        }

        const winner = entries.random();
        message.channel.send(`🎉 Winner: **${winner.tag}**`);

        sendLog(
          message.guild,
          new EmbedBuilder()
            .setTitle("🎉 Giveaway Logged")
            .setDescription(`Prize: **${prize}**\nWinner: **${winner.tag}**`)
            .setColor(0x00ffea)
            .setTimestamp()
        );
      } catch (err) {
        console.error("Giveaway Error:", err);
      }
    }, duration * 1000);

    return;
  }

  // ⭐ !RblxAnnounce
  if (cmd === "!rblxannounce") {
    const content = args.slice(1).join(" ");
    if (!content.includes("|")) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Invalid Format")
            .setDescription("Use: `!rblxannounce Title | Description`")
            .setColor(0xff0000)
        ]
      });
    }

    const [title, description] = content.split("|").map(x => x.trim());

    try {
      await axios.post("https://orionbot-production.up.railway.app/announce", {
        title,
        description
      });

      message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("📢 Announcement Sent")
            .setDescription("Your announcement has been relayed to Roblox.")
            .setColor(0x00ffea)
        ]
      });

      sendLog(
        message.guild,
        new EmbedBuilder()
          .setTitle("📢 Roblox Announcement Sent")
          .setDescription(`**${title}**\n${description}`)
          .setColor(0x00ffea)
          .setTimestamp()
      );

    } catch (err) {
      console.error("Announcement Error:", err);
      message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle("❌ Failed")
            .setDescription("Could not send announcement.")
            .setColor(0xff0000)
        ]
      });
    }

    return;
  }
});

// ----------------------------------------------------
// LOGIN BOT
// ----------------------------------------------------
client.login(process.env.DISCORD_TOKEN);