const { Client, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.GuildModeration,
  ]
});

// ── Base de données en mémoire ──────────────────────────
const db = {
  sanctions: [],
  history: [],
  usernames: [],
  recentJoins: [],
  tickets: [],
  panicMode: false,
};

// ── Commandes ───────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('diagnostic')
    .setDescription('Analyse complète du serveur')
    .toJSON(),

  new SlashCommandBuilder()
    .setName('panic')
    .setDescription('🚨 Active/désactive le mode panique')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(s => s.setName('on').setDescription('Activer').addStringOption(o => o.setName('raison').setDescription('Raison')))
    .addSubcommand(s => s.setName('off').setDescription('Désactiver'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ai-scan')
    .setDescription('🧠 Analyse IA d\'un membre')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('membre').setDescription('Membre à analyser').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('📜 Historique d\'un membre')
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('🔨 Bannir un membre')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true))
    .addStringOption(o => o.setName('raison').setDescription('Raison'))
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('🎫 Gestion des tickets')
    .addSubcommand(s => s.setName('open').setDescription('Ouvrir un ticket').addStringOption(o => o.setName('sujet').setDescription('Sujet').setRequired(true)))
    .addSubcommand(s => s.setName('close').setDescription('Fermer le ticket'))
    .addSubcommand(s => s.setName('add').setDescription('Ajouter un membre').addUserOption(o => o.setName('membre').setDescription('Membre').setRequired(true)))
    .toJSON(),
];

// ── Ready ───────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ SOS Serveur connecté : ${client.user.tag}`);
  client.user.setActivity('🛡️ Protection active', { type: 3 });

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('✅ Commandes enregistrées');
  } catch(e) {
    console.error('Erreur commandes:', e);
  }
});

// ── Anti-raid : détection à chaque join ─────────────────
client.on('guildMemberAdd', async member => {
  const now = Date.now();
  const accountAge = (now - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);

  db.history.push({ userId: member.id, event: '📥 JOIN', detail: member.user.tag, timestamp: now });
  const last = db.usernames.filter(u => u.userId === member.id).slice(-1)[0];
  if (!last || last.username !== member.user.username) {
    db.usernames.push({ userId: member.id, username: member.user.username, timestamp: now });
  }

  db.recentJoins = db.recentJoins.filter(j => now - j.timestamp < 30000);
  db.recentJoins.push({ userId: member.id, username: member.user.username, avatar: member.user.avatar, accountAge, timestamp: now });

  if (db.recentJoins.length >= 5) {
    const avgAge = db.recentJoins.reduce((s, j) => s + j.accountAge, 0) / db.recentJoins.length;
    const patterns = db.recentJoins.map(j => j.username.toLowerCase().replace(/\d+/g, ''));
    const unique = new Set(patterns).size;
    const similarity = 1 - (unique / db.recentJoins.length);
    let risk = 0;
    if (db.recentJoins.length >= 8) risk += 40;
    else if (db.recentJoins.length >= 5) risk += 20;
    if (similarity > 0.6) risk += 35;
    if (avgAge < 7) risk += 25;

    if (risk >= 50) {
      const logChannel = member.guild.channels.cache.find(c => c.name.includes('log'));
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle(`⚠️ RISQUE RAID : ${risk}%`)
          .setColor(risk >= 80 ? 0xFF0000 : 0xFFA500)
          .addFields(
            { name: 'Joins (30s)', value: `${db.recentJoins.length}`, inline: true },
            { name: 'Age moyen', value: `${avgAge.toFixed(1)} jours`, inline: true },
            { name: 'Similarité pseudos', value: `${Math.round(similarity*100)}%`, inline: true },
          )
          .setTimestamp();
        logChannel.send({ embeds: [embed] });
      }

      if (risk >= 90 && !db.panicMode) {
        db.panicMode = true;
        for (const [, channel] of member.guild.channels.cache.filter(c => c.type === ChannelType.GuildText)) {
          channel.permissionOverwrites.edit(member.guild.roles.everyone, { SendMessages: false }).catch(() => {});
        }
      }
    }
  }
});

// ── Interactions ─────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (interaction.isButton() && interaction.customId === 'ticket_close') {
    await interaction.reply('🔒 Fermeture...');
    setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // ── /diagnostic ───────────────────────────────────────
  if (interaction.commandName === 'diagnostic') {
    await interaction.deferReply();
    const guild = interaction.guild;
    await guild.members.fetch();

    const members = guild.members.cache;
    const totalMembers = members.size;
    const bots = members.filter(m => m.user.bot).size;
    const humains = totalMembers - bots;
    const enligne = members.filter(m => ['online','idle','dnd'].includes(m.presence?.status)).size;
    const channels = guild.channels.cache;
    const texte = channels.filter(c => c.type === 0).size;
    const vocal = channels.filter(c => c.type === 2).size;
    const roles = guild.roles.cache;
    const rolesAdmin = roles.filter(r => r.permissions.has('Administrator')).size;
    const rolesSansMembre = roles.filter(r => r.members.size === 0 && !r.managed && r.id !== guild.id).size;

    let score = 100;
    const problemes = [], solutions = [], positifs = [];

    if (humains < 10) { score -= 10; problemes.push('Peu de membres'); solutions.push('Fais de la promotion'); }
    else positifs.push(`${humains} membres humains`);
    if (rolesAdmin > 3) { score -= 15; problemes.push(`${rolesAdmin} rôles admin`); solutions.push('Limite les rôles admin'); }
    else positifs.push('Permissions bien gérées');
    if (rolesSansMembre > 5) { score -= 10; problemes.push(`${rolesSansMembre} rôles vides`); solutions.push('Supprime les rôles inutiles'); }
    if (texte > 30) { score -= 5; problemes.push('Trop de salons texte'); solutions.push('Regroupe tes salons'); }

    score = Math.max(0, Math.min(100, score));
    const emoji = score >= 80 ? '🟢' : score >= 50 ? '🟠' : '🔴';
    const couleur = score >= 80 ? 0x22c55e : score >= 50 ? 0xf97316 : 0xef4444;

    await interaction.editReply({ embeds: [
      new EmbedBuilder().setTitle(`🔍 Diagnostic — ${guild.name}`).setColor(couleur).setThumbnail(guild.iconURL())
        .addFields(
          { name: '📊 Note', value: `**${emoji} ${score}/100**` },
          { name: '👥 Membres', value: `Total: **${totalMembers}** | Humains: **${humains}** | Bots: **${bots}** | En ligne: **${enligne}**` },
          { name: '💬 Salons', value: `Texte: **${texte}** | Vocal: **${vocal}**` },
          { name: '🎭 Rôles', value: `Admin: **${rolesAdmin}** | Vides: **${rolesSansMembre}**` },
        ).setFooter({ text: 'SOS Serveur • Par looxoYTB & Zertox' }).setTimestamp(),
      new EmbedBuilder().setTitle('✅ Points positifs').setColor(0x22c55e).setDescription(positifs.map(p => `✅ ${p}`).join('\n') || 'Aucun'),
      new EmbedBuilder().setTitle('⚠️ Problèmes').setColor(0xef4444).setDescription(problemes.map(p => `❌ ${p}`).join('\n') || '✅ Aucun problème !'),
      new EmbedBuilder().setTitle('💡 Solutions').setColor(0x3b82f6).setDescription(solutions.map((s,i) => `**${i+1}.** ${s}`).join('\n') || '✅ Tout est bon !'),
    ]});
  }

  // ── /panic ────────────────────────────────────────────
  else if (interaction.commandName === 'panic') {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();

    if (sub === 'on') {
      if (db.panicMode) return interaction.editReply('⚠️ Déjà actif !');
      db.panicMode = true;
      let locked = 0, webhooksDeleted = 0;

      for (const [, channel] of interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText)) {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: false, AddReactions: false }).catch(() => {});
        await channel.setRateLimitPerUser(3600).catch(() => {});
        locked++;
      }
      try {
        const webhooks = await interaction.guild.fetchWebhooks();
        for (const [, wh] of webhooks) { await wh.delete('PANIC MODE'); webhooksDeleted++; }
      } catch {}

      await interaction.editReply({ embeds: [
        new EmbedBuilder().setTitle('🚨 MODE PANIQUE ACTIVÉ').setColor(0xFF0000)
          .addFields(
            { name: '🔒 Salons lockés', value: `${locked}`, inline: true },
            { name: '🕸️ Webhooks supprimés', value: `${webhooksDeleted}`, inline: true },
          ).setFooter({ text: 'Utilise /panic off pour rétablir' }).setTimestamp()
      ]});

    } else {
      db.panicMode = false;
      let unlocked = 0;
      for (const [, channel] of interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText)) {
        await channel.permissionOverwrites.edit(interaction.guild.roles.everyone, { SendMessages: null, AddReactions: null }).catch(() => {});
        await channel.setRateLimitPerUser(0).catch(() => {});
        unlocked++;
      }
      await interaction.editReply(`✅ Mode panique désactivé — **${unlocked}** salons déverrouillés.`);
    }
  }

  // ── /ai-scan ──────────────────────────────────────────
  else if (interaction.commandName === 'ai-scan') {
    await interaction.deferReply();
    const member = interaction.options.getMember('membre');
    if (!member) return interaction.editReply('❌ Membre introuvable.');

    const accountAge = (Date.now() - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
    const username = member.user.username;
    let score = 0;
    const details = [];

    if (accountAge < 1) { score += 40; details.push(`⚠️ Compte créé il y a ${Math.round(accountAge*24)}h`); }
    else if (accountAge < 7) { score += 25; details.push(`⚠️ Compte de ${Math.round(accountAge)} jours`); }
    else if (accountAge < 30) { score += 10; details.push(`📅 Compte de ${Math.round(accountAge)} jours`); }
    else details.push(`✅ Compte de ${Math.round(accountAge/30)} mois`);

    if (/discord|free|nitro|gift/i.test(username)) { score += 35; details.push('🚨 Pseudo suspect (nitro/gift/free)'); }
    else if (/^[a-z]+\d{4,}$/i.test(username)) { score += 20; details.push('⚠️ Pattern de pseudo suspect'); }
    else details.push('✅ Pseudo normal');

    if (!member.user.avatar) { score += 15; details.push('⚠️ Pas d\'avatar'); }
    else details.push('✅ Avatar personnalisé');

    const flags = member.user.flags?.toArray() || [];
    if (flags.length > 0) { score -= 10; details.push(`✅ Badges: ${flags.slice(0,3).join(', ')}`); }

    score = Math.max(0, Math.min(100, score));
    const risk = score >= 60 ? 'DANGEROUS' : score >= 30 ? 'SUSPICIOUS' : 'SAFE';
    const emoji = score >= 60 ? '🔴' : score >= 30 ? '🟡' : '🟢';
    const color = score >= 60 ? 0xFF0000 : score >= 30 ? 0xFFA500 : 0x00FF88;

    await interaction.editReply({ embeds: [
      new EmbedBuilder().setTitle(`${emoji} Analyse IA — ${member.user.tag}`)
        .setColor(color).setThumbnail(member.user.displayAvatarURL())
        .setDescription(details.join('\n'))
        .addFields(
          { name: 'Score', value: `**${score}/100**`, inline: true },
          { name: 'Statut', value: `**${risk}**`, inline: true },
          { name: 'Age', value: `**${Math.round(accountAge)} jours**`, inline: true },
        ).setFooter({ text: `ID: ${member.id}` }).setTimestamp()
    ]});
  }

  // ── /history ──────────────────────────────────────────
  else if (interaction.commandName === 'history') {
    await interaction.deferReply({ ephemeral: true });
    const user = interaction.options.getUser('membre');
    const sanctions = db.sanctions.filter(s => s.userId === user.id);
    const usernames = db.usernames.filter(u => u.userId === user.id).slice(-5);
    const events = db.history.filter(h => h.userId === user.id).slice(-5);

    const embed = new EmbedBuilder()
      .setTitle(`📋 Historique — ${user.tag}`)
      .setColor(0x5865F2).setThumbnail(user.displayAvatarURL())
      .setFooter({ text: `ID: ${user.id}` }).setTimestamp();

    embed.addFields({ name: `⚖️ Sanctions (${sanctions.length})`, value: sanctions.length > 0 ? sanctions.slice(-5).map(s => `\`${s.type}\` — ${s.reason}`).join('\n') : '✅ Aucune' });
    if (usernames.length > 0) embed.addFields({ name: '🏷️ Pseudos passés', value: usernames.map(u => `\`${u.username}\``).join(', ') });
    if (events.length > 0) embed.addFields({ name: '📅 Activité', value: events.map(e => `${e.event} ${e.detail}`).join('\n') });

    await interaction.editReply({ embeds: [embed] });
  }

  // ── /ban ──────────────────────────────────────────────
  else if (interaction.commandName === 'ban') {
    await interaction.deferReply({ ephemeral: true });
    const target = interaction.options.getMember('membre');
    const raison = interaction.options.getString('raison') || 'Aucune raison';
    if (!target) return interaction.editReply('❌ Membre introuvable.');
    if (!target.bannable) return interaction.editReply('❌ Je ne peux pas bannir ce membre.');

    try {
      await target.ban({ reason: `${raison} | Par: ${interaction.user.tag}` });
      db.sanctions.push({ userId: target.id, type: 'BAN', reason: raison, moderator: interaction.user.tag, timestamp: Date.now() });

      const logChannel = interaction.guild.channels.cache.find(c => c.name.includes('log'));
      if (logChannel) {
        logChannel.send({ embeds: [
          new EmbedBuilder().setTitle('🔨 Bannissement').setColor(0xFF4444)
            .addFields(
              { name: 'Membre', value: `${target.user.tag}`, inline: true },
              { name: 'Modérateur', value: `${interaction.user.tag}`, inline: true },
              { name: 'Raison', value: raison },
            ).setTimestamp()
        ]});
      }
      await interaction.editReply(`✅ **${target.user.tag}** banni. Raison: *${raison}*`);
    } catch(e) {
      await interaction.editReply(`❌ Erreur: ${e.message}`);
    }
  }

  // ── /ticket ───────────────────────────────────────────
  else if (interaction.commandName === 'ticket') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'open') {
      await interaction.deferReply({ ephemeral: true });
      const sujet = interaction.options.getString('sujet');
      const existing = db.tickets.find(t => t.userId === interaction.user.id && t.status === 'open');
      if (existing) return interaction.editReply(`❌ T'as déjà un ticket ouvert: <#${existing.channelId}>`);

      const channel = await interaction.guild.channels.create({
        name: `ticket-${interaction.user.username}`,
        type: ChannelType.GuildText,
        permissionOverwrites: [
          { id: interaction.guildId, deny: [PermissionFlagsBits.ViewChannel] },
          { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });

      db.tickets.push({ channelId: channel.id, userId: interaction.user.id, status: 'open' });

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
      );

      await channel.send({ embeds: [
        new EmbedBuilder().setTitle(`🎫 Ticket — ${sujet}`)
          .setDescription(`Bonjour <@${interaction.user.id}> !\nUn membre du staff va te répondre.`)
          .setColor(0x5865F2)
      ], components: [row] });

      await interaction.editReply(`✅ Ticket créé: ${channel}`);

    } else if (sub === 'close') {
      const ticket = db.tickets.find(t => t.channelId === interaction.channelId && t.status === 'open');
      if (!ticket) return interaction.reply({ content: '❌ Pas un ticket ouvert.', ephemeral: true });
      ticket.status = 'closed';
      await interaction.reply('🔒 Fermeture dans 5 secondes...');
      setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);

    } else if (sub === 'add') {
      const membre = interaction.options.getMember('membre');
      await interaction.channel.permissionOverwrites.edit(membre, { ViewChannel: true, SendMessages: true });
      await interaction.reply(`✅ <@${membre.id}> ajouté.`);
    }
  }
});

client.login(TOKEN);
