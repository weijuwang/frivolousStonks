/*
    frivolousStonks: A virtual stock market for Discord servers.
    Copyright (C) 2022 Matthew Epshtein, Weiju Wang.

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import * as Discord from 'discord.js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as schedule from 'node-schedule';

const STOCKDATA = "stockData.json";
const TICKERS = "tickers.json";
const MAXDATAPOINTS = 24 * 60;
const TRUEPRICEWEIGHT = 0.5; // where 1 = weight equal to the current actual price

interface GuildStockData {
  data: number[],
  truePrice: number,
  actualPrice: number
}

interface GuildTempData {
  authors: string[],
  numMessages: number
}

function readJSONFile(filename: string){
  return JSON.parse(fs.readFileSync(filename).toString());
}

function writeJSONFile(filename: string, object: Object){
  fs.writeFileSync(filename, JSON.stringify(object));
}

let tempMsgData: {
  [key: string]: GuildTempData
} = {};

dotenv.config({ path: __dirname + '/.env' });

const client: Discord.Client = new Discord.Client({
  intents: [
    Discord.GatewayIntentBits.Guilds,
    Discord.GatewayIntentBits.GuildMessages,
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

    case 'getprice':

      if(interaction.guild === null){
        await interaction.reply("This command cannot be used in DMs.");
        break;
      }

      let tickerOrId = interaction.options.getString('ticker');

      // If no ticker was given
      if(tickerOrId === null)
        tickerOrId = interaction.guildId!;

      const originalTickerOrId = tickerOrId; // copy of original, for display purposes

      // Assume `tickerOrId` is a guild ID. Find the guild, if any, that it represents
      let guild = client.guilds.cache.get(tickerOrId);

      // If no guild with the ID in `tickerOrId` was found
      if(guild === undefined){

        // Get the ID that `tickerOrId` represents
        tickerOrId = readJSONFile(TICKERS)[tickerOrId.toUpperCase()];

        if(tickerOrId === undefined){
          await interaction.reply("Stock ticker or server ID not found.");
          break;
        }

        // Find the guild with that ID
        guild = client.guilds.cache.get(tickerOrId!);

        if(guild === undefined){
          await interaction.reply("Server not found (it is likely no longer trading).");
          break;
        }
      }

      await interaction.reply(
        Discord.bold(originalTickerOrId!)
        + " "
        + Discord.italic(guild!.name)
        + ": ₦"
        + readJSONFile(STOCKDATA)[tickerOrId!].actualPrice.toFixed(2)
      );

      break;

    case 'setticker':

      if(interaction.guild === null){
        await interaction.reply("This command cannot be used in DMs.");
        break;
      }

      const ticker = interaction.options.getString('ticker')?.toUpperCase();
      const tickers = readJSONFile(TICKERS);

      if(ticker === undefined){
        await interaction.reply("No ticker provided.");
        break;
      }

      if(tickers[ticker] !== undefined){
        await interaction.reply("That ticker is already being used.");
        break;
      }

      // TODO Check ticker constraints

      tickers[ticker] = interaction.guildId!;
      writeJSONFile(TICKERS, tickers);

      await interaction.reply(`This server's ticker is now "${ticker}".`)

      break;

    default:
      await interaction.reply(`Unknown command ${interaction.commandName}`);
      break;
  }
});

client.on('messageCreate', async (message: Discord.Message) => {

  // Do not respond to bots
  if(message.author.bot)
    return;

  let thisServerData = tempMsgData[message.guildId!];

  if(thisServerData === undefined){
    thisServerData = {
      authors: [],
      numMessages: 0
    };
  }

  // If this user hasn't talked since the last update, add them as an author
  if(!thisServerData.authors.includes(message.author.id)){
    thisServerData.authors.push(message.author.id);
  }

  ++thisServerData.numMessages;

  tempMsgData[message.guildId!] = thisServerData;
});

// Currently, this updates EVERY MINUTE. When changing the frequency, remember to also modify MAXDATAPOINTS.
schedule.scheduleJob('0 * * * * *', () => {

  // Read data
  let stockData: {
    [key: string]: GuildStockData
  } = readJSONFile(STOCKDATA);

  client.guilds.cache.forEach(guild => {

    let numMessages = 0;
    let numAuthors = 1; // this must be 1 to avoid divide by zero

    if(guild.id in tempMsgData){
      numAuthors = tempMsgData[guild.id].authors.length;
      numMessages = tempMsgData[guild.id].numMessages;
    }

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

    let thisServer = stockData[guild.id];

    if(thisServer != null){

      let newData = thisServer.data;

      // Add data from the last hour
      newData.unshift(Math.log(guild.memberCount) * (numMessages / numAuthors));

      // Remove the oldest data point (from exactly 24 hours ago)
      if(newData.length > MAXDATAPOINTS)
        newData.pop();

      thisServer.data = newData;

      // Compute the average of all data points
      thisServer.truePrice = newData.reduce((a: number, b: number) => a + b) / newData.length;

      // The true price pulls the actual price towards it with a certain weight
      thisServer.actualPrice =
        (thisServer.actualPrice + thisServer.truePrice * TRUEPRICEWEIGHT)
        / (TRUEPRICEWEIGHT + 1);

      stockData[guild.id] = thisServer;

    } else {
      // This is the first time we've collected data from this server
      const firstDataPoint = Math.log(guild.memberCount) * (numMessages / numAuthors);

      stockData[guild.id] = {
        data: [firstDataPoint],
        truePrice: firstDataPoint,
        actualPrice: firstDataPoint
      };
    }
  });

  // Write data back to the file
  writeJSONFile(STOCKDATA, stockData);

  tempMsgData = {};
});

client.login(process.env.DISCORD_TOKEN);