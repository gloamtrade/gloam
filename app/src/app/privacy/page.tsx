import type { Metadata } from "next";
import { liveMainnetNames } from "@/lib/mainnet";
import Link from "next/link";
import { LegalLayout } from "@/components/LegalLayout";
import { EMBEDDED_WALLETS } from "@/lib/embeddedWallet";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy" updated="November 8, 2026">
      <p>
        This Privacy Policy describes what information Gloam (&ldquo;we,&rdquo;
        &ldquo;us&rdquo;) handles when you use gloam.trade, the Gloam app, the
        API, the hosted MCP server and Glim, our Telegram helper (the
        &ldquo;Services&rdquo;). It describes how the Services work today.
        Blockchain transactions are public by nature unless a privacy protocol
        applies, and even then, guarantees are limited.
      </p>
      <h2>1. Mainnet and testnet</h2>
      <p>
        Gloam runs on two kinds of network. On mainnet (Robinhood Chain and
        Tempo, from Gloam&apos;s mainnet launch on 21 October 2026) it has
        deposit limits, and it was
        reviewed internally before launch. Kann Audits then reviewed the vault
        contracts (<Link href="/security">report, 1 November 2026</Link>) and
        found no Critical, High or Medium issues. On
        the testnets (Tempo Moderato testnet and Robinhood Chain testnet) the
        tokens you use are test tokens. Do not send mainnet funds
        to a testnet address or contract.
      </p>
      <h2>2. What Gloam never has</h2>
      <p>
        Gloam is self-custodial. Your wallet&apos;s keys stay in your wallet.
        Your private balance lives in your browser: your notes, their secrets
        and your receive keys are made and kept there, and proofs are made in
        your browser too. We never receive your keys, your seed phrase or your
        note secrets.
      </p>
      {EMBEDDED_WALLETS && (
        <p>
          If you sign in with your email or a passkey and create a Gloam wallet,
          that wallet&apos;s key is made and kept by Turnkey, the service Gloam
          wallets run on, inside its secure hardware. It never reaches the page
          or our servers. Turnkey signs with it when your signed-in session
          asks, and keeps a record of each request, signatures included. Turnkey
          gives Gloam&apos;s Turnkey account read-only visibility into the
          account it keeps for you. Your private balance still lives in your
          browser, as above.
        </p>
      )}
      <p>
        We never hold your funds. Money in the Gloam vault contract leaves only
        with a valid proof, and there is no admin withdraw. Any change to how
        proofs are checked needs three days of public notice on chain.
      </p>
      <p>
        We will never ask for a seed phrase or private key. Never share them
        with anyone claiming to represent Gloam.
      </p>
      <h2>3. On-chain data</h2>
      <p>
        Activity on public blockchains is visible to anyone. The public
        addresses you connect, the transactions you send and their hashes are
        shared with the network by design. Private features reduce what is
        visible on explorers, but metadata, timing, amounts at deposit and cash
        out, and third-party infrastructure may still reveal information. We do
        not control the networks.
      </p>
      <p>
        Your browser talks to each network&apos;s RPC nodes and explorers
        directly. They see your IP address and the addresses you look up, under
        their own policies. When the app shows your public wallet&apos;s recent
        activity, our server asks that network&apos;s explorer for that
        address: the Robinhood Chain testnet explorer, or the Robinhood Chain
        mainnet explorer when you are on mainnet.
      </p>
      <h2>4. Usage data</h2>
      <p>
        <strong>Gloam product counts.</strong>{" "}When you reach a step in the
        app, such as connecting a wallet, finishing a deposit, sending
        privately, making a proof or applying to test, your browser sends a
        short event to gloam.trade/api/collect. It holds the event name, the
        page, the referring address (its site and path, never its query
        string), the time, and a few safe details such as the network, the kind
        of proof or a count. Our server adds your browser&apos;s user agent
        (the line that names your browser and system). It drops anything that
        could be an amount, an address, a name, a label, a note or a proof,
        even if a browser sends it. No cookie or ID is used, and your IP address
        is not kept with the event. These counts run only if you choose
        &ldquo;Accept all&rdquo; in the cookie banner. We keep the
        latest 5,000 events, daily totals for 120 days, and running totals. We
        may also post the events to a private team chat.
      </p>
      <p>
        <strong>Claim-link counts.</strong>{" "}To see whether payment links
        reach people, the app adds 1 to one of four daily totals: a claim link
        was made (once its payment lands), a claim link was opened in Gloam, a
        claim link was claimed, and someone who claimed a link made their own
        first payment. The request carries only which of the four it is, and
        whether it happened on mainnet or a testnet. It has
        no cookie or ID, and nothing about the link, the amount, the people
        involved or your wallet, and our server keeps no IP address or browser
        details with it. Your browser remembers on its own which links it
        already counted, so the same one is not counted twice. Because these
        totals cannot say who did what, they run whether or not you accept the
        cookie banner. We keep the daily totals for about 13 months.
      </p>
      <p>
        <strong>People counts.</strong>{" "}To know how many people use Gloam,
        the app tells our server your wallet address when you connect, and
        which of a few things you did: claimed a payment, deposited, sent
        privately, swapped, cashed out, ran payroll or paid a request. The
        things you did are sent a few minutes later, together, and each counts
        once a day. Nothing else goes with it: no amount, note, claim code,
        transaction or recipient. Our server turns the address into a one-way
        code with a secret key and adds the code to counters that can only say
        roughly how many different wallets they have seen, in all, for each
        action and for each day. The address is not stored or logged, and the
        counters cannot be turned back into a list of wallets. We do the same
        with the wallets that deposit into the vault or receive a cash out,
        which anyone can already see on chain. Mainnet and testnets are counted
        apart, and the recording demo is not counted. Someone holding both our
        secret key and the counters could check whether a wallet they already
        know is probably in them; the key stays on our server. Because nothing
        kept can say who you are, these counts run whether or not you accept
        the cookie banner. Your browser remembers what it already sent today.
        We keep the daily counters for 35 days and the others while the
        Services run.
      </p>
      <p>
        <strong>Vercel Web Analytics.</strong>{" "}Our hosting provider, Vercel,
        counts page views for us. It runs only if you choose &ldquo;Accept
        all&rdquo; and sets no cookies. Vercel
        says it tells visits apart with a hash of the request that it discards
        after 24 hours, and records the page, the referring site, your rough
        location (country, region, city), and your browser, operating system
        and device type. We cut the page link at the first &ldquo;?&rdquo; or
        &ldquo;#&rdquo; before it is sent, so the details in a payment request
        or proof link never reach Vercel.
      </p>
      <p>
        <strong>Our visit count (optional).</strong>{" "}Only if you choose
        &ldquo;Accept all,&rdquo; the site also sends us a visit event when it
        loads (the page you land on and the referring address), and which
        network you view on the Transparency page. It holds the same fields as
        the product counts and is kept the same way.
      </p>
      <p>
        <strong>Rate limits.</strong>{" "}To stop abuse we count requests per IP
        address. The address is hashed before it is counted, and each count
        expires on its own: within minutes for most limits, and within two
        days for daily ones.
      </p>
      <p>
        <strong>Request logs.</strong>{" "}Our hosting provider keeps standard
        request logs (time, path, IP address and response status) for no more
        than 30 days. A path can include a public wallet address, for example
        when the app looks up that wallet&apos;s activity. Our server code also
        writes short logs, such as the product counts above and error messages,
        and an error message can include details of the request that failed.
      </p>
      <h2>5. Cookies and local storage</h2>
      <p>
        We set no advertising or tracking cookies. The only cookies we set are
        sign-in cookies for the partner portal and the team&apos;s admin page.
        The app keeps your private balance, settings and preferences in your
        browser&apos;s local storage, and none of it is sent to us except an
        encrypted recovery backup if you turn recovery on (section 8).
        {EMBEDDED_WALLETS &&
          " If you sign in to a Gloam wallet, Turnkey's code keeps your sign-in session in this browser: a session key in its database and a session token in local storage, until you sign out or the session ends."}{" "}
        Details and your choices:{" "}
        <a href="/cookies">
          Cookie Policy
        </a>
        .
      </p>
      <h2>6. The relay</h2>
      <p>
        When you send privately or cash out, the app can submit the transaction
        for you from a Gloam relay account, so your wallet does not appear next
        to it on a block explorer. You can turn this off and send from your own
        wallet.
      </p>
      <p>
        The relay receives the proof and its public inputs. For a cash out
        these include the amount, the asset and the address you cash out to,
        which become public on chain anyway. For a private send it sees no
        amount and no recipient. For a private swap, which always goes through
        the relay, it sees the tokens and amounts, which become public on chain
        anyway. A payment message it posts for you is
        encrypted for the recipient, and the relay cannot read it. The relay
        never receives your keys, your note secrets or your private balance,
        and it cannot change where money goes: the most it can do is refuse to
        submit.
      </p>
      <p>
        Beyond the transaction itself, which is public on chain, the relay
        keeps only a hashed rate-limit count and, for up to about three minutes, a
        lock on each spend so the same proof is not sent twice. The relay pays
        the network fee for what it submits. On mainnet, Gloam takes 0.5% of a
        cash out, kept by the vault. A private swap pays the same 0.5% on the
        amount swapped, and what its price buffer does not use goes to the
        Gloam treasury. Base Sepolia and Ethereum Sepolia keep 0.25% of a cash out;
        the other testnets charge nothing.
      </p>
      <h2>7. Sanctions screening</h2>
      <p>
        Before a deposit, a trade or a cash out, we check the public wallet
        address involved against a copy of the US Treasury&apos;s OFAC list of
        sanctioned digital currency addresses. The check runs in your browser,
        then again on our server and in the relay. We may also ask
        Chainalysis&apos;s free sanctions API about the address. When that is
        on, Chainalysis receives the address. On Tempo we also read the
        stablecoin issuer&apos;s transfer policy from the chain. We do not log
        the addresses we screen, and the answer is only allowed or blocked.
      </p>
      <h2>8. Recovery backups</h2>
      <p>
        If you turn on recovery, your browser encrypts a copy of what it holds
        for you and stores only that encrypted copy on our servers. The copy
        contains:
      </p>
      <ul>
        <li>the private notes you can spend (your private balance);</li>
        <li>your receive keys, which open payments sent to your Gloam address;</li>
        <li>
          the payment links you sent and have not seen claimed, which can
          include the payment codes inside them;
        </li>
        <li>payroll runs that still have payments on their way.</li>
      </ul>
      <p>
        It is encrypted in your browser, before it leaves, with a key made
        from your wallet&apos;s signature or your passkey. We can&apos;t read
        it{EMBEDDED_WALLETS && " (except a backup made with a Gloam wallet's signature, below)"},
        and it is filed under an id that doesn&apos;t reveal your wallet.
        It is replaced each time your browser backs up, and it stays until you
        turn recovery off in Settings, which deletes it from our servers. We
        don&apos;t delete it on a schedule. Anyone who gets your recovery
        signature or passkey could open your backup and spend what is in it,
        so only sign the recovery message on gloam.trade.
      </p>
      {EMBEDDED_WALLETS && (
        <p>
          With a Gloam wallet, the app offers recovery with a passkey: the key
          comes from the passkey on your device and never leaves it, so neither
          we nor Turnkey can open that backup. Nothing turns on without your
          say. If your browser can&apos;t make a passkey backup, you can choose
          the Gloam wallet&apos;s signature instead. Turnkey makes and keeps
          that signature, so Turnkey, and anyone with access to Gloam&apos;s
          Turnkey account, could open a backup made with it. The app says so
          before you choose it.
        </p>
      )}
      <h2>9. Tester applications and contest entries</h2>
      <p>
        If you apply at gloam.trade/testers, we keep what you send: your name,
        Telegram and X handles, the network you want to test, your device and
        wallet, your note, and your EVM address, which we pay tester rewards
        to or, for volunteers, use to match you to your testing on chain. We
        also note when you applied and whether you hold a paid or a volunteer
        spot. We use it to let you into the private testers group, to match
        testing to testers and to pay rewards, and for nothing else. Only the Gloam team can read it. Your IP
        address is not kept with your application; the rate limit holds a
        hashed copy for up to two hours. We delete applications 90 days after
        the testers program ends, or sooner if you ask at{" "}
        <a href="mailto:hello@gloam.trade">hello@gloam.trade</a>.
      </p>
      <p>
        If you enter the video contest at gloam.trade/contest, we keep what you
        send: your name, X handle, the link to your post, the network you
        used, your note and, if you give it, your email. We also note when you
        entered, when you last changed your entry, and when you agreed that
        Gloam may use your video for marketing with credit to you. We use it to
        judge the contest, to reach and pay winners, and to show we have your
        permission when we use a video, and for nothing else. Only the Gloam
        team can read it. Your IP address is not kept with your entry; the
        rate limit holds a hashed copy for up to two hours. We delete entries
        90 days after winners are paid, except the name, handle, post link and
        consent time for a video we use, which we keep while we use it. Ask at{" "}
        <a href="mailto:hello@gloam.trade">hello@gloam.trade</a> to have yours
        deleted sooner.
      </p>
      <h2>10. Glim, our Telegram helper</h2>
      <p>
        Glim is a bot in the Gloam Telegram group (t.me/gloamhq). It reads the
        messages posted in the group, not only the ones sent to it, so it can
        answer questions, save bug reports, and remove scams and pasted
        secrets. It does not reply to private messages, except from the team.
      </p>
      <p>
        <strong>Anthropic.</strong>{" "}Glim uses Anthropic&apos;s API to write its
        answers. To answer a message, it sends Anthropic the message, your
        Telegram first name, the last few messages in that topic (first names
        and text), and any picture you post or ask it about, such as a
        screenshot. A quick check of whether a message needs an answer also
        sends the message text. Anthropic processes this to write the reply,
        under its own terms. Payment codes, claim links and Gloam addresses are
        replaced with labels before any text is sent.
      </p>
      <p>
        <strong>Raeto.</strong>{" "}For a plain text question in the group, Glim
        first asks Raeto (raeto.cc), a partner service, which of its models
        should write the answer. Raeto gets the text of that one message, up to
        600 characters, and nothing else: no name, no earlier messages and no
        pictures. A message with a payment code, a claim link, a Gloam address,
        a 0x address or something that looks like a seed phrase or key is never
        sent to Raeto.
      </p>
      <p>
        <strong>What Glim keeps.</strong>{" "}In our database, Glim keeps the last
        few messages of each topic (first name and text) for about six hours,
        so follow-ups make sense. It keeps bug reports for the team: your
        Telegram user ID, username, first name, the topic, the text and a link
        to the message (the latest 500 are kept). It keeps the text of the
        questions it answered, without names, for about two days, and Anthropic
        turns them into a daily summary for the team. It keeps questions it
        handed to an admin (first name, topic, text and link) for about three
        days, and hourly counts of messages, joins and leaves, with Telegram
        user IDs, for three days. It also keeps new members&apos; first names
        until the next welcome message, and short flags tied to your Telegram
        user ID, for a day at most, so it does not repeat itself. It does not
        store pictures.
      </p>
      <p>
        <strong>Secrets.</strong>{" "}Glim never stores text that looks like a
        seed phrase or private key, and deletes a message that shows one when
        it can. A picture is sent to Anthropic before Glim knows what it shows,
        so never post a seed phrase or private key, in text or in a screenshot.
      </p>
      <p>
        Telegram&apos;s own privacy policy covers everything you post on
        Telegram.
      </p>
      <h2>11. Partner portal and API</h2>
      <p>
        To sign in to the partner portal, you sign a message with your wallet
        (Sign-In with Ethereum). We keep your wallet address, the partner name
        and website you enter, the payout addresses and fee settings you
        choose, and your API keys. API keys are stored only as hashes, so we
        can check a key but cannot read it back. For each transaction made with
        your key we record the network, the kind, the transaction hash and the
        time, and for deposits and cash outs the asset and amount, which are
        public on chain. We never record a note, a secret, the recipient of a
        private send or a private amount. A sign-in cookie keeps you signed in
        for up to 7 days.
      </p>
      <p>
        <strong>Paying or swapping through a partner&apos;s link.</strong>{" "}A
        partner&apos;s link can carry their partner code. When you pay, cash out
        or swap from such a link, the app asks us which partner the code belongs
        to (to show their name), and ties your transaction to the code before it
        is sent: through the Gloam relay, the code goes with the send and the relay
        ties it to a one-way hash of the payment just before sending, and to the
        transaction it sends (kept seven days; an hour if the send never goes
        out); from your own wallet, the app first sends us one-way hashes of the
        payment and of a value only that payment has, with the code. We keep that
        for an hour at most. Once your
        transaction lands, we read it on its chain and record it against the
        partner: the transaction hash, the network, the kind, the asset and amount
        where they are public, the vault&apos;s fee and the time, which anyone can
        already see on chain. We do not record your wallet address, your IP
        address, the address a cash out paid, or anything else about you with it.
        For a cash out sent later by the relay, the code is kept with the relay&apos;s
        job until it goes out, and the app keeps the job&apos;s id in your browser
        for at most seven days.
      </p>
      <p>
        <strong>What the partner sees.</strong>{" "}For a cash out or a swap from
        their link: its transaction hash, network, token, amount and time, and
        which of their link codes it came through. All of that is public on chain
        already. For a private payment from their link: only a count per day,
        added once the day has ended (UTC), in their dashboard, its spreadsheets
        and their API alike. Never its hash, amount, time, recipient or the code
        it came through, and it never changes the &quot;last activity&quot; they
        see, so they can&apos;t tell which payment was yours. They never see your
        wallet or IP address.
      </p>
      <p>
        <strong>Partners&apos; own addresses.</strong>{" "}A partner can give us
        their own receiving addresses. We then count past cash outs from the vault
        to those addresses as theirs, from the same public facts. We keep only the
        partner&apos;s addresses, nothing about who sent the money.
      </p>
      <h2>12. Hosted MCP server (gloam.trade/mcp)</h2>
      <p>
        The hosted MCP server lets AI clients such as Claude, ChatGPT and Cursor
        read information about Gloam and plan actions. It never holds funds,
        never signs transactions, and refuses any tool call that looks like it
        contains a private key, recovery phrase or note secret.
      </p>
      <p>
        <strong>Tool inputs and outputs.</strong>{" "}What a tool call carries, such
        as the details of a payment request or a proof you ask it to check, is
        processed in memory to answer that one call and is not stored. We do not
        receive your conversation with the AI client, only the tool calls it
        sends.
      </p>
      <p>
        <strong>Rate limiting.</strong>{" "}To prevent abuse we count requests per IP
        address. The address is hashed before it is counted, and each count
        expires within two minutes.
      </p>
      <p>
        <strong>Request logs.</strong>{" "}Our hosting provider keeps standard request
        logs (time, path, IP address and response status) for no more than 30
        days. Request bodies are not logged.
      </p>
      <p>
        <strong>The local server.</strong>{" "}The Gloam MCP server you run yourself
        (npx @gloamtrade/mcp) runs on your own machine. Its keys, spending limits
        and encrypted notes stay there, and we never receive them.
      </p>
      <h2>13. Messages you send us and email updates</h2>
      <p>
        If you write to us by email, on X or on Telegram, we keep your message
        and your contact details so we can reply.
      </p>
      <p>
        If you ask for Gloam updates by email, we keep only that email, the day
        you asked and where (sign-in, Settings or the site), and use it only to
        send updates. It is stored on its own, apart from any wallet, and you
        can unsubscribe with the link in any update or in the app under Settings.
      </p>
      <h2>14. How we use information</h2>
      <p>
        To operate and improve the Services, secure systems, debug issues,
        understand aggregate usage, run the testers program, communicate about
        the product, and comply with law. We do not sell your personal
        information.
      </p>
      <h2>15. Sharing and service providers</h2>
      <p>
        These providers process data for us, each as described above:
      </p>
      <ul>
        <li>Vercel: hosting, request logs and Web Analytics.</li>
        <li>
          Upstash: our database, for tester applications, recovery backups,
          partner accounts, Glim&apos;s records, usage counts and rate-limit
          counts.
        </li>
        <li>Anthropic: writing Glim&apos;s answers and daily summary.</li>
        <li>Raeto: choosing which model writes Glim&apos;s answers in the group.</li>
        <li>Telegram: runs the group and delivers its messages to Glim.</li>
        <li>Chainalysis: sanctions checks, when we turn them on.</li>
        <li>
          The RPC nodes and explorers of each network Gloam runs on, on{" "}
          {liveMainnetNames()}, and Tempo&apos;s fee
          sponsor when you use Tempo Wallet on the testnet.
        </li>
        <li>
          Relay (relay.link): when you bring money over, our server asks Relay
          for a route and sends it the chains, the tokens, the amount, your
          wallet, where the money lands and a refund address. For a deposit
          straight into your private balance it also sends the vault deposit
          that Relay makes for you. We then ask Relay how the order is going.
          Relay fills the order under its own terms.
        </li>
        {EMBEDDED_WALLETS && (
          <li>
            Turnkey, only when you sign in with your email or a passkey to use
            a Gloam wallet. Turnkey receives your email address (it sends you
            the sign-in code), your passkey&apos;s public key and name, the
            account and wallet it makes for you and their addresses, every
            request your wallet signs (messages and transactions, with their
            chain) and the signatures it makes, which Gloam&apos;s Turnkey
            account can also view, and your IP address and browser details. When Gloam covers
            a network fee for you, Turnkey sends that transaction and records
            its cost. It keeps your wallet&apos;s key encrypted in its secure
            hardware and processes all of this under its own privacy policy.
          </li>
        )}
        <li>
          WalletConnect (Reown), only when you choose Use a wallet app: its
          relay passes encrypted messages between the page and your wallet app
          and sees your IP address. It does not start otherwise.
        </li>
      </ul>
      <p>
        The wallet you connect is run by its maker under its own terms. We may
        also share data with professional advisors, or with authorities when
        the law requires it.
      </p>
      <h2>16. Retention</h2>
      <p>
        We keep each kind of data for the time stated above. Where no time is
        stated, such as partner accounts and running totals, we keep it while
        the Services run. On-chain data persists for the life of the network.
      </p>
      <h2>17. Security</h2>
      <p>
        We use reasonable technical and organizational measures, but no method
        of transmission or storage is fully secure. You are responsible for
        securing your own devices and wallets.
      </p>
      <h2>18. International transfers</h2>
      <p>
        Services may be hosted in multiple regions. By using them, you
        understand information may be processed outside your country.
      </p>
      <h2>19. Your choices</h2>
      <p>
        You can disconnect your wallet, choose &ldquo;Essential only&rdquo; in
        the Cookie Policy, turn the relay off, turn recovery off (which deletes
        your backup), and clear this site&apos;s data in your browser.
        Depending on your jurisdiction, you may have rights to access, correct,
        or delete personal data we hold off-chain. Contact us to exercise those
        rights. We cannot change or delete data on a blockchain.
      </p>
      <h2>20. Children</h2>
      <p>
        The Services are not directed to children under 18 (or the age of
        majority where you live). We do not knowingly collect their data.
      </p>
      <h2>21. Changes</h2>
      <p>
        We may update this Policy by posting a new version with a revised date.
      </p>
      <h2>22. Contact</h2>
      <p>
        Privacy questions: <a href="mailto:hello@gloam.trade">hello@gloam.trade</a>{" "}
        or{" "}
        <a href="https://x.com/gloamtrade">
          @gloamtrade
        </a>
        .
      </p>
    </LegalLayout>
  );
}
