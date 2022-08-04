import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as cro from 'child_process';
import * as schedule from 'node-schedule';

function deployer(){

    /*
    All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.
    */
    
    fs.readFile('sdc.ts', 'utf8', (err, data) => {

        if(err)
            return console.log(err);

        let past = data;

        fs.readFile('deployCommands.ts', 'utf8', (err, data) => {
            if(err)
                return console.log(err);
    
            if(past != data){
                cro.exec("npm deployCommands");
                // TODO error handling later
            }
        });
    });
}

deployer();

let counters: number[] = [];

function update(counters:number[]) {
   /*
    All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.
    */
  let counter:number = counters.length;
  conters.length = 0;
  return counter;
}

dotenv.config({ path: __dirname + '/.env' });

const client: Discord.Client = new Discord.Client({
    intents: [
        Discord.GatewayIntentBits.Guilds,
        Discord.GatewayIntentBits.GuildMembers,
        Discord.GatewayIntentBits.GuildMessages,
        Discord.GatewayIntentBits.MessageContent
    ]
});

client.on('ready', () => {
    console.log(`Add with https://discord.com/api/oauth2/authorize?client_id=${client!.user!.id}&permissions=2147485697&scope=bot`);
});



client.on('interactionCreate', async (interaction: Discord.Interaction) => {

    if(!interaction.isChatInputCommand())
        return;

    switch(interaction.commandName){
        case 'ping':
            await interaction.reply('pong');
            break;

        default:
            await interaction.reply(`Unrecognized command ${interaction.commandName}`);
            break;
    }
});

client.on('messageCreate', async (message: Discord.Message) => {

    // Do not respond to bots
    if(message.author.bot)
        return;
    else{
      //check for uniqueness
      counters.push("1");
    };
});

schedule.scheduleJob('0 */1 * * * *', () => {
   update(counters);
});

client.login(process.env.DISCORD_TOKEN);