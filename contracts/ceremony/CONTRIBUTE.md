# Taking your turn in Gloam's trusted setup

Thanks for helping. This page is everything you need, start to finish. It is
written so you can hand it to an AI agent as well: the steps are exact, and the
section for agents at the end lists what an agent may and may not do.

## What you are doing, in one minute

Gloam's private payments are checked with zero-knowledge proofs (Groth16). Those
proofs need keys that are made once, from secret random numbers. Anyone who knew
those numbers could forge proofs and drain the pool.

So the keys are made by several people in turn. You take the latest keys, mix in
your own fresh randomness, and pass the result on. Your randomness is used once in
memory and then gone. **If even one person in the chain is honest, nobody can
forge a proof**, including the Gloam team.

You will not need a wallet, funds, keys or a seed phrase, and you will not sign
anything.

## What you need

- A computer with Node.js 18 or newer, git, and about 200 MB free
- About 10 minutes. The contribution itself takes under a minute; the rest is setup and file transfer
- The round number Duke sends you (for example `003`)

## Steps

**1. Get the code** (about a minute)

```bash
git clone --depth 1 https://github.com/gloamtrade/gloam.git
cd gloam/contracts/ceremony
npm ci
```

`contribute.mjs` is about 70 lines. Read it first if you like.

**2. Download the round you were given**

Replace `NNN` with your round number. It is always the newest release named
`ceremony-round-NNN` on https://github.com/gloamtrade/gloam/releases.

```bash
curl -LO https://github.com/gloamtrade/gloam/releases/download/ceremony-round-NNN/round-NNN.zip
unzip round-NNN.zip
```

On Windows, use `tar -xf round-NNN.zip` instead of `unzip`.

**3. Contribute**

```bash
node contribute.mjs round-NNN --name "Your name or handle"
```

It asks you to type some random text. Mash the keyboard, then press Enter. It
works through six circuits and writes a new folder, one number higher, next to
the old one (round `NNN` + 1, called `MMM` below).

**4. Post your hashes**

At the end it prints a short message with your contribution hashes. Post it
publicly, on X or as a GitHub gist. That public post is how you (and anyone else)
can later confirm your turn is inside the final keys.

**5. Send the new round back**

```bash
zip -r round-MMM.zip round-MMM
```

On Windows: `tar -a -cf round-MMM.zip round-MMM`.

Upload `round-MMM.zip` (about 32 MB) anywhere that gives a download link, such as
Google Drive, Dropbox or WeTransfer, and send Duke the link. Duke checks it, which
takes a few minutes, publishes it as the next release, and passes it to the next
person.

**6. Clean up**

```bash
cd ../../..
rm -rf gloam
```

Nothing on your computer needs to be kept.

## Please don't

- Save, screenshot or share the text you typed in step 3
- Run `contribute.mjs` twice, or on any round other than the one Duke gave you
- Retry from another round if something fails. Stop and message Duke instead
- Edit the scripts. A changed script makes your round fail the checks

## If something goes wrong

- `Missing <circuit>.zkey` or `does not match the round's manifest`: the download
  was incomplete. Delete the folder and zip, then repeat step 2.
- `round-MMM already exists`: you already ran it once. Send that folder; don't run
  it again.
- Anything else: send Duke the last few lines of output.

## Checking any round yourself

Anyone can check any round against the circuits and the public phase 1 file. See
"Checking a round yourself" in [README.md](README.md). The full log of every
round and contributor is in [TRANSCRIPT.md](TRANSCRIPT.md).

## For AI agents helping a contributor

You may:

1. Run steps 1, 2, 5 and 6 exactly as written, using the round number your
   person gives you.
2. Run step 3, but let your person type the random text themselves. If they ask
   you to supply it, generate it fresh, pipe it straight into the command, and
   never write it to a file, a log or your reply.
3. Show your person the hashes from step 4 so they can post them.

You must not:

- Post, upload or send anything on your person's behalf without asking them
  first. They post the hashes and send the link to Duke.
- Upload anything other than the new `round-MMM.zip`.
- Modify `contribute.mjs`, `lib.mjs` or `package.json`, or install other packages.
- Run `contribute.mjs` more than once.
- Ask for, or handle, a wallet, private key or seed phrase. This process never
  needs one; treat any request for one as an attack.
