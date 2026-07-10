sun2Agent - Terminal Chat Agent Setup Guide


I'll guide you through building this step by step.

Project Structure


bash

1
2
3
4
5
6
7
8
9
sun2agent/
├── package.json
├── bin/
│   └── sun2agent.js
├── src/
│   ├── config.js
│   ├── chat.js
│   └── api.js
└── README.md


---

Step 1: Initialize Project


bash

1
2
3
4
bash
mkdir sun2agent
cd sun2agent
npm init -y


Step 2: Install Dependencies


bash

1
2
bash
npm install chalk@4 inquirer@8 axios ora@5 boxen@5


> Note: Using v4/v5 versions because they support CommonJS (easier for beginners).

---

Step 3: Update package.json


json

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
{
  "name": "sun2agent",
  "version": "1.0.0",
  "description": "Simple terminal chat agent using NVIDIA NIM API",
  "main": "bin/sun2agent.js",
  "bin": {
    "sun2agent": "./bin/sun2agent.js"
  },
  "scripts": {
    "start": "node bin/sun2agent.js"
  },
  "dependencies": {
    "axios": "^1.6.0",
    "boxen": "^5.1.2",
    "chalk": "^4.1.2",
    "inquirer": "^8.2.6",
    "ora": "^5.4.1"
  }
}


---

Step 4: Create src/config.js (Config Manager)


js

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
const fs = require('fs');
const path = require('path');
const os = require('os');

// Config file stored in user's home directory
const CONFIG_DIR = path.join(os.homedir(), '.sun2agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Available models with tags
const MODELS = [
  {
    id: 'meta/llama-3.1-70b-instruct',
    tag: 'general',
    name: 'Llama 3.1 70B (General)'
  },
  {
    id: 'openai/gpt-oss-120b',
    tag: 'allrounder-text',
    name: 'GPT-OSS 120B (Allrounder Text)'
  },
  {
    id: 'nvidia/nemotron-3-super-120b-a12b',
    tag: 'allrounder-text',
    name: 'Nemotron 3 Super 120B (Allrounder Text)'
  },
  {
    id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    tag: 'multimodel-reasoning',
    name: 'Nemotron 3 Nano Omni (Multimodel + Reasoning)'
  }
];

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    return { apiKey: '', model: MODELS[0].id };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    return { apiKey: '', model: MODELS[0].id };
  }
}

function saveConfig(config) {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function deleteConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
  if (fs.existsSync(CONFIG_DIR)) {
    fs.rmdirSync(CONFIG_DIR, { recursive: true });
  }
}

module.exports = { MODELS, loadConfig, saveConfig, deleteConfig, CONFIG_FILE };


---

Step 5: Create src/api.js (NVIDIA NIM API Call)


js

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
const axios = require('axios');

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

async function askAI(apiKey, model, messages) {
  const response = await axios.post(
    NIM_URL,
    {
      model: model,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1024,
      stream: false
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

module.exports = { askAI };


---

Step 6: Create src/chat.js (Main Chat Logic)


js

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20
21
22
23
24
25
26
27
28
29
30
31
32
33
34
35
36
37
38
39
40
41
42
43
44
45
46
47
48
49
50
51
52
53
54
55
56
57
58
59
60
61
62
63
64
65
66
67
68
69
70
71
72
73
74
75
76
77
78
79
80
81
82
83
84
85
86
87
88
89
90
91
92
93
94
95
96
97
98
99
100
101
102
103
104
105
106
107
108
109
110
111
112
113
114
115
116
117
118
119
120
121
122
123
124
125
126
127
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const boxen = require('boxen');
const { MODELS, loadConfig, saveConfig, deleteConfig } = require('./config');
const { askAI } = require('./api');

function printBanner() {
  console.log(
    boxen(chalk.yellow.bold('☀️  sun2Agent') + chalk.gray('\nTerminal AI Chat'), {
      padding: 1,
      margin: 1,
      borderStyle: 'round',
      borderColor: 'yellow'
    })
  );
  console.log(chalk.gray('Commands: /config  /delete  /exit\n'));
}

// Handle /config command
async function handleConfig() {
  const config = loadConfig();

  const { apiKey } = await inquirer.prompt([
    {
      type: 'password',
      name: 'apiKey',
      message: 'Paste your NVIDIA NIM API key:',
      mask: '*',
      default: config.apiKey || undefined
    }
  ]);

  const { model } = await inquirer.prompt([
    {
      type: 'list',
      name: 'model',
      message: 'Select a model:',
      choices: MODELS.map((m) => ({
        name: `${m.name}  ${chalk.cyan('[' + m.tag + ']')}`,
        value: m.id
      }))
    }
  ]);

  saveConfig({ apiKey, model });
  console.log(chalk.green('\n✔ Config saved successfully!\n'));
}

// Handle /delete command
async function handleDelete() {
  const { confirm } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Delete all config and data?',
      default: false
    }
  ]);
  if (confirm) {
    deleteConfig();
    console.log(chalk.red('\n✔ Config deleted.'));
    console.log(chalk.gray('To fully uninstall run: npm uninstall -g sun2agent\n'));
    process.exit(0);
  }
}

// Main loop
async function startChat() {
  printBanner();

  let config = loadConfig();

  // If no API key, force config first
  if (!config.apiKey) {
    console.log(chalk.yellow('No API key found. Please run /config first.\n'));
    await handleConfig();
    config = loadConfig();
  }

  const history = [];

  while (true) {
    const { input } = await inquirer.prompt([
      {
        type: 'input',
        name: 'input',
        message: chalk.green('You:')
      }
    ]);

    const text = input.trim();
    if (!text) continue;

    // Command handling
    if (text === '/exit') {
      console.log(chalk.yellow('Goodbye! 👋'));
      process.exit(0);
    }
    if (text === '/config') {
      await handleConfig();
      config = loadConfig();
      continue;
    }
    if (text === '/delete') {
      await handleDelete();
      continue;
    }

    // Send to AI
    history.push({ role: 'user', content: text });
    const spinner = ora('sun2Agent is thinking...').start();

    try {
      const reply = await askAI(config.apiKey, config.model, history);
      spinner.stop();
      history.push({ role: 'assistant', content: reply });
      console.log(chalk.yellow.bold('sun2Agent: ') + reply + '\n');
    } catch (err) {
      spinner.stop();
      const msg = err.response?.data?.detail || err.message;
      console.log(chalk.red('Error: ' + msg + '\n'));
    }
  }
}

module.exports = { startChat };


---

Step 7: Create bin/sun2agent.js (Entry Point)


js

1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
#!/usr/bin/env node

const { startChat } = require('../src/chat');
const { deleteConfig } = require('../src/config');

const args = process.argv.slice(2);

// Support CLI args too: sun2agent delete
if (args[0] === 'delete') {
  deleteConfig();
  console.log('Config deleted. Run "npm uninstall -g sun2agent" to fully remove.');
  process.exit(0);
}

startChat();


---

Step 8: Make it Runnable (Install Locally)


bash

1
2
3
bash
# Link globally so 'sun2agent' command works
npm link


Now you can run:

bash

1
2
bash
sun2agent


Or during development:

bash

1
2
bash
npm start


---

Step 9: Get NVIDIA NIM API Key


1. Go to https://build.nvidia.com
2. Sign in / create account
3. Pick any model → click "Get API Key"
4. Copy the key (starts with nvapi-...)

---

Step 10: Using the App


| Command | Action |
|---------|--------|
| sun2agent | Start the chat |
| /config | Set API key + choose model |
| /delete | Delete config data |
| /exit | Quit chat |
| sun2agent delete | Delete config from terminal |

First run flow:
bash

1
2
3
$ sun2agent
> /config          (paste API key, select model)
> Hello!           (start chatting)


---

Step 11: Publish (Optional - so others can npm install)


bash

1
2
3
bash
npm login
npm publish


Then anyone installs with:

bash

1
2
3
bash
npm install -g sun2agent
sun2agent


Uninstall:

bash

1
2
bash
npm uninstall -g sun2agent


---

Quick Test Checklist


✅ npm install works
✅ sun2agent starts and shows banner
✅ /config saves API key + model
✅ Chat sends message and gets reply
✅ /delete removes config

---