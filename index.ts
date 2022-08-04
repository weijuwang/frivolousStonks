import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as cro from 'child_process';
import * as schedule from 'node-schedule';

/*
function deployer(){

  // All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.

  fs.readFile('sdc.ts', 'utf8', (err, data) => {

    if (err)
      return console.log(err);

    let past = data;

    fs.readFile('deployCommands.ts', 'utf8', (err, data) => {
      if (err)
        return console.log(err);

      if (past != data) {
        cro.exec("npm deployCommands");
        // TODO error handling later
      }
    });
  });
}

deployer();
*/

let counter: number = 0;

function update(counters: number, servername: string, numauthors: number, nummembers: number) {

  /*
   All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.
   */
  /*
  UPDATE FUNCTTION
    params: #of messages in a given interval, name of the server, number of users that sent messages in a given interval, total number of members in the server
    results: 
      1.Updates the servercounts.json file with data passed into the function
      2.clears the counter for messages
    returns:
      0 if everything went smoothly
      !0 if problems occured

  */
  //TODO: FILE WRITING
  let serverData = JSON.parse(fs.readFileSync('servercounts.json', 'utf8'));
  let serverLookup = serverData[servername];

  if (serverLookup != null) {
    let mesList = serverLookup.measurements;
    mesList.unshift(Math.log(nummembers) * (counter / numauthors));
    // formula subject to change
    if (mesList.length > 24) {
      mesList.pop();
    }
    serverLookup.average = mesList.reduce((a, b) => a + b) / 24;
    serverData[servername] = serverLookup;
    // write to file
  } else {
    serverData[servername] = {
      servername: servername,
      measurements: [Math.log(nummembers) * (counter / numauthors)],
      average: Math.log(nummembers) * (counter / numauthors)
    }
    // write to file

  }

  counter = 0;
  return counter;
  //sneaky way of errorchecking counter reset
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

  if (!interaction.isChatInputCommand())
    return;

  switch (interaction.commandName) {
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
  if (message.author.bot)
    return;

  counter++;

});

schedule.scheduleJob('0 */1 * * * *', () => {
  update(counter);
});

client.login(process.env.DISCORD_TOKEN);