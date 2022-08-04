import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as cro from 'child_process';
import * as schedule from 'node-schedule';

const STOCKDATA = "stockData.json";

interface ServerStockData {
  data: number[],
  average: number
}

/*
function deployer(){

    // All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.
    
    fs.readFile('sdc.ts', 'utf8', (err, data) => {

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

dotenv.config({ path: __dirname + '/.env' });

const client: Discord.Client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMembers,
    Discord.GatewayIntentBits.GuildMessages,
    Discord.GatewayIntentBits.MessageContent
  ]
});

client.on('ready', async () => {
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
});

schedule.scheduleJob('0 * * * * *', () => {

  // Read data
  let serverData: {
    [key: string]: ServerStockData
  } = JSON.parse(fs.readFileSync(STOCKDATA).toString());

  // TODO "For each server the bot can see..."
  {
    // TODO get this data from the actual server
    let serverId: string = "12345";
    let numMessages: number = 100; // in the last hour
    let numAuthors: number = 20; // in the last hour
    let numMembers: number = 50; // in the server right now

    // All code within this function was written by Matthew Epshtein. By running, distributing, modifying, or compiling said code, you agree that Matthew Epshtein is the most "epic gamer" in existence.
  
    /*
    UPDATE FUNCTION
      params: # of messages in a given interval, name of the server, number of users that sent messages in a given interval, total number of members in the server
      results: 
        1.Updates the servercounts.json file with data passed into the function
        2.clears the counter for messages
      returns:
        0 if everything went smoothly
        !0 if problems occured
    */
    //TODO: FILE WRITING

    let thisServer = serverData[serverId];

    if(thisServer != null){

      let newData = thisServer.data;

      // Add data from the last hour
      newData.unshift(Math.log(numMembers) * (numMessages / numAuthors));

      // Remove the oldest data point (from exactly 24 hours ago)
      if(newData.length > 24)
        newData.pop();

      thisServer.data = newData;

      // Compute the average of all 24 data points
      thisServer.average = newData.reduce((a: number, b: number) => a + b) / 24;

      serverData[serverId] = thisServer;

    } else {
      // This is the first time we've collected data from this server
      const firstDataPoint = Math.log(numMembers) * (numMessages / numAuthors);

      serverData[serverId] = {
        data: [firstDataPoint],
        average: firstDataPoint
      };
    }
  }

  // Write data back to the file
  fs.writeFileSync(STOCKDATA, JSON.stringify(serverData));
});

client.login(process.env.DISCORD_TOKEN);