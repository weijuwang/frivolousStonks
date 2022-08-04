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

interface GuildStockData {
  data: number[],
  truePrice: number,
  actualPrice: number
}
interface userData {
  coins: number,
  stocks_owned: {serverID:string, amount:number}

}
interface GuildTempData {
  authors: string[],
  numMessages: number
}

const STOCKDATA = "stockData.json";
const USERDATA = "userData.json"
const MAXDATAPOINTS = 24 * 60;
const TRUEPRICEWEIGHT = 1; // where 1 = weight equal to the current actual price

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
    //deploycommands.ts, define a command
      //declare/initialize stockdata
    case 'printalluserdata':
      await interaction.reply(stockData);
      break;
    case 'getprice':
      let ticker = interaction.options.getString('ticker');

      if(ticker === null)
        ticker = interaction.guildId!;

      let guildName = client.guilds.cache.get(ticker)?.name ?? "???";

      let serverData: {
        [key: string]: GuildStockData
      } = JSON.parse(fs.readFileSync(STOCKDATA).toString());

      if(ticker in serverData){
        await interaction.reply(
          Discord.bold(ticker)
          + " "
          + Discord.italic(guildName)
          + ": ₦"
          + serverData[ticker].actualPrice.toFixed(2)
        );
        break;
      } else {
        await interaction.reply('Server not found.');
      }

      break;
    case 'setticker':
      let ourticker = interaction.options.getString('ticker')!;
      let id = interaction.guildId!
      let getserverData: {
        [key: string]: GuildStockData
      } = JSON.parse(fs.readFileSync(STOCKDATA).toString());
      if(id in getserverData){
        getserverData[ourticker] = getserverData[id];
        delete getserverData[id];
        fs.writeFileSync(STOCKDATA, JSON.stringify(getserverData));
        await interaction.reply("Done.")
      }
       
      

    default:
      await interaction.reply(`Unrecognized command ${interaction.commandName}`);
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
  } = JSON.parse(fs.readFileSync(STOCKDATA).toString());
  
  let userData: {
    [key: string]: userData
  } = JSON.parse(fs.readFileSync(USERDATA).toString());

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
      //Guild.id can be a temp thing, ill make a command to set a ticker for a server
      const firstDataPoint = Math.log(guild.memberCount) * (numMessages / numAuthors);

      stockData[guild.id] = {
        data: [firstDataPoint],
        truePrice: firstDataPoint,
        actualPrice: firstDataPoint
      };
    }
  });

  // Write data back to the file
  fs.writeFileSync(STOCKDATA, JSON.stringify(stockData));

  tempMsgData = {};
});

client.login(process.env.DISCORD_TOKEN);