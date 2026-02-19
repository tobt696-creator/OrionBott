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

// ----------------------------------------------------
// DATA PERSISTENCE (Railway Volume)
// ----------------------------------------------------
const DATA_DIR = "/app/data";

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


const mongoose = require("mongoose");

mongoose.connect("mongodb+srv://ORIONBOT:ORION66@cluster0.hmmh1ng.mongodb.net/?appName=Cluster0")
  .then(() => console.log("MongoDB Connected ✅"))
  .catch((err) => console.log(err));

// ----------------------------------------------------
// IN-MEMORY STORES (BACKED BY JSON)
// ----------------------------------------------------
let codeToUserId = loadJson("codes.json", {});          // codeToUserId["123456"] = "2010692028"
let linkedAccounts = loadJson("linked.json", {});       // linkedAccounts["2010692028"] = "1403467428255633428"

// PRODUCT SYSTEM STORES
let products = loadJson("products.json", {});           // products[productId] = { id, name, description, imageId, devProductId, fileName, fileDataBase64 }
let ownedProducts = loadJson("owned.json", {});         // ownedProducts[robloxUserId] = [productId, ...]
let devProductToProductId = loadJson("devmap.json", {});// devProductToProductId[devProductId] = productId

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
app.post("/addProduct", (req, res) => {
  const { name, description, imageId, devProductId, fileName, fileData } = req.body;

  if (!name || !description || !imageId || !devProductId || !fileName || !fileData) {
    return res.json({ success: false, message: "Missing product fields" });
  }

  const productId = Date.now().toString(); // simple unique id

  products[productId] = {
    id: productId,
    name,
    description,
    imageId,
    devProductId: String(devProductId),
    fileName,
    fileDataBase64: fileData
  };

  devProductToProductId[String(devProductId)] = productId;

  saveJson("products.json", products);
  saveJson("devmap.json", devProductToProductId);

  console.log("Product added:", products[productId]);

  return res.json({ success: true, productId });
});

// ----------------------------------------------------
// ⭐ PRODUCT API: REMOVE PRODUCT
// body: { productId }
// ----------------------------------------------------
app.post("/removeProduct", (req, res) => {
  const { productId } = req.body;

  if (!productId || !products[productId]) {
    return res.json({ success: false, message: "Invalid productId" });
  }

  const devId = products[productId].devProductId;
  delete products[productId];

  if (devId && devProductToProductId[devId]) {
    delete devProductToProductId[devId];
  }

  // Remove from owned lists
  for (const userId in ownedProducts) {
    ownedProducts[userId] = ownedProducts[userId].filter(id => id !== productId);
  }

  saveJson("products.json", products);
  saveJson("devmap.json", devProductToProductId);
  saveJson("owned.json", ownedProducts);

  console.log("Product removed:", productId);

  return res.json({ success: true });
});

// ----------------------------------------------------
// ⭐ PRODUCT API: LIST PRODUCTS (for Roblox UI)
// GET /products
// ----------------------------------------------------
app.get("/products", (req, res) => {
  const list = Object.values(products).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    imageId: p.imageId,
    devProductId: p.devProductId
  }));

  return res.json({ products: list });
});

// ----------------------------------------------------
// ⭐ PRODUCT API: OWNED PRODUCTS (for Roblox UI)
// GET /owned/:userId
// ----------------------------------------------------
app.get("/owned/:userId", (req, res) => {
  const userId = String(req.params.userId);
  const owned = ownedProducts[userId] || [];
  return res.json({ owned });
});

// ----------------------------------------------------
// ⭐ PRODUCT API: PURCHASE (from Roblox)
// body: { userId, devProductId }
// CLEANED + FIXED VERSION
// ----------------------------------------------------
app.post("/purchase", async (req, res) => {
  const { userId, devProductId } = req.body;

  if (!userId || !devProductId) {
    return res.json({ success: false, message: "Missing userId or devProductId" });
  }

  const productId = devProductToProductId[String(devProductId)];
  if (!productId || !products[productId]) {
    return res.json({ success: false, message: "Unknown product" });
  }

  const product = products[productId];

  // Get Discord ID linked to this Roblox user
  const discordId = linkedAccounts[userId];
  if (!discordId) {
    console.log("No linked Discord account for Roblox user:", userId);
    return res.json({ success: false, message: "User not linked" });
  }

  try {
    const user = await client.users.fetch(discordId);

    // Convert stored base64 file back to buffer
    const fileBuffer = Buffer.from(product.fileDataBase64, "base64");

    // Send DM with file + description
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle(`🎁 You received: ${product.name}`)
          .setDescription(product.description)
          .setColor(0x00ffea)
      ],
      files: [
        {
          attachment: fileBuffer,
          name: product.fileName
        }
      ]
    });

    // Save ownership
    if (!ownedProducts[userId]) ownedProducts[userId] = [];
    if (!ownedProducts[userId].includes(productId)) {
      ownedProducts[userId].push(productId);
    }

    saveJson("owned.json", ownedProducts);

    console.log("DM sent to", discordId);
    return res.json({ success: true });

  } catch (err) {
    console.error("Failed to DM user:", err);
    return res.json({ success: false, message: "DM failed" });
  }
});

// ⭐ START WEB SERVER (Railway-compatible)
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
});

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

client.on("ready", () => {
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
  const badWords = ["badword1", "badword2"];

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
            "`!coinflip` – Flip a coin"
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
            "`!removeproduct` – Remove a shop product"
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
    // DM-based flow
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

    const ask = async (question) => {
      await dm.channel.send({
        embeds: [
          new EmbedBuilder()
            .setDescription(question)
            .setColor(0x00ffea)
        ]
      });

      const collected = await dm.channel.awaitMessages({
        filter: m => m.author.id === message.author.id,
        max: 1,
        time: 60000
      });

      if (!collected.size) return null;
      return collected.first();
    };

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
      await axios.post("https://orionbot-production.up.railway.app/addProduct", {
        name: productName,
        description: productDescription,
        imageId,
        devProductId,
        fileName: file.name,
        fileData: Buffer.from(fileBuffer).toString("base64")
      });

      dm.channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Product Added")
            .setDescription(`**${productName}** has been added to the shop.`)
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

    let desc = list.map(p => `**ID:** ${p.id}\n**Name:** ${p.name}\n**DevProductId:** ${p.devProductId}`).join("\n\n");

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