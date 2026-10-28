# Stratego 3D

Classic Stratego on a 3D board, for two players on two different computers, tablets or phones.

1. Open the game and type your name.
2. Pick your army: **Red** (moves first) or **Blue**.
3. Send the link (or the 5-letter game code) to a friend.
4. While you wait, arrange your 40 pieces: tap two pieces to swap them, or press **Shuffle**.
5. When your friend opens the link they get the other army. Once you both press **I'm ready**, the battle starts.

Drag to turn the board, scroll or pinch to zoom. There's a chat box, a battle log, and a count of the enemy pieces still standing. After a game, press **Play again** for a rematch.

## Putting it online (GitHub Pages)

The game is plain HTML, CSS and JavaScript with no build step, so GitHub Pages can host it for free:

1. On GitHub, open the repository and go to **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**, pick **main** and **/ (root)**, then **Save**.
3. After a minute the game is live at `https://seniorslearningai-droid.github.io/Stratego3D/`.

## How the online play works

There is no game server to run. The two browsers talk directly to each other using [PeerJS](https://peerjs.com/) (WebRTC); PeerJS's free public service is only used to introduce them.

The player who creates the game is the **host**. Their browser keeps the real game and checks every move against the rules. Each player is only sent what they are allowed to see, so the other side's ranks stay hidden until pieces fight.

- If either player reloads the page, the game picks up where it left off (the host's browser saves it).
- If the guest's connection drops, they reconnect automatically.
- If the host closes their browser, the game pauses until they open the same link again.
- A third person who opens the link is told the game already has two players.

## Rules in brief

- Higher rank wins an attack; equal ranks both leave the board. Both ranks are shown during the battle, then the winner turns face-down again, so you have to remember what you saw.
- Bombs and the Flag never move. Anything that hits a Bomb loses, except a Miner (3).
- Scouts (2) move any number of empty squares in a straight line.
- The Spy beats the Marshal (10) only when the Spy attacks.
- No shuttling between the same two squares more than three turns in a row.
- Capture the enemy Flag, or leave them with nothing that can move, to win.

The full rules are under the **?** button in the game.

## Running it on your own computer

You need [Node.js](https://nodejs.org/) (any recent version).

```bash
npm start
```

Then open http://localhost:8080. To try both sides on one computer, open the invite link in a second browser tab.

```bash
npm test
```

runs the rules tests.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `css/style.css` | The page: lobby, side panel, pop-ups |
| `js/game.js` | Stratego rules (no graphics), shared by the host and the tests |
| `js/net.js` | The connection between the two browsers |
| `js/scene.js` | The 3D board and pieces (three.js) |
| `js/main.js` | Ties it all together: lobby, turns, chat, saving |
| `js/sound.js` | Small sound effects |
| `tests/game.test.mjs` | Rules tests |
| `dev-server.mjs` | Tiny local web server for `npm start` |
