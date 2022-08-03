import * as Discord from 'discord.js';

const client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildMessages
    ]
});

client.on('ready', () => {
    console.log("Add with https://discord.com/api/oauth2/authorize?client_id=1004486701177110708&permissions=2147485697&scope=bot");
});

client.login(process.env.DISCORD_TOKEN);