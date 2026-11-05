// A realistic roleplay setup for the equivalence test: display, prompt and save-time scripts, depth limits,
// macros, escaped substitution, alternation, Unicode, and a chat in English and Korean.
// It deliberately avoids the inputs that trigger the bugs fixed since the baseline; each of those has its own case.
import { P, script } from './scenarios.js';

export const SCRIPTS = () => [
    script({ scriptName: 'Status card', findRegex: '/<status>([\\s\\S]*?)<\\/status>/g', replaceString: '<div class="status">$1</div>', markdownOnly: true }),
    script({ scriptName: 'Hide thinking (prompt)', findRegex: '/<thinking>[\\s\\S]*?<\\/thinking>\\n?/g', replaceString: '', promptOnly: true }),
    script({ scriptName: 'Fold thinking', findRegex: '/<thinking>([\\s\\S]*?)<\\/thinking>/g', replaceString: '<details><summary>Thinking</summary>$1</details>', markdownOnly: true }),
    script({ scriptName: 'Bold tag', findRegex: '/\\*\\*(.+?)\\*\\*/g', replaceString: '<b>$1</b>', markdownOnly: true, placement: [P.AI, P.USER] }),
    script({ scriptName: '「」 quotes', findRegex: '/「(.+?)」/g', replaceString: '<q>$1</q>', markdownOnly: true }),
    script({ scriptName: 'OOC', findRegex: '/\\bOOC:\\s*(.*)$/gim', replaceString: '<span class="ooc">$1</span>', markdownOnly: true, placement: [P.AI, P.USER] }),
    script({ scriptName: 'Trailing spaces', findRegex: '/[ \\t]+$/gm', replaceString: '' }),
    script({ scriptName: 'Old image prompts', findRegex: '/<img-prompt>[\\s\\S]*?<\\/img-prompt>/g', replaceString: '', promptOnly: true, minDepth: 2 }),
    script({ scriptName: 'HP meter (last message)', findRegex: '/\\[HP: (\\d+)\\/(\\d+)\\]/g', replaceString: '<meter value="$1" max="$2"></meter>', markdownOnly: true, maxDepth: 0 }),
    script({ scriptName: 'Narrator name', findRegex: '/\\bnarrator\\b/gi', replaceString: '{{char}}', markdownOnly: true }),
    script({ scriptName: 'Strip user prefix', findRegex: '/^{{user}}: /gm', replaceString: '', substituteRegex: 1, placement: [P.USER] }),
    script({ scriptName: 'Says (escaped)', findRegex: '/{{char}} says/g', replaceString: '{{match}}!', substituteRegex: 2, markdownOnly: true }),
    script({ scriptName: 'Note', findRegex: '/\\[note: (.*?)\\]/g', replaceString: '<i>$1</i>', trimStrings: ['"'], markdownOnly: true }),
    script({ scriptName: 'Wave', findRegex: '/(?<who>\\w+) waves/g', replaceString: '$<who> 👋', markdownOnly: true }),
    script({ scriptName: 'Breaks (prompt)', findRegex: '/<br\\s*\\/?>|<hr\\s*\\/?>/gi', replaceString: '\n', promptOnly: true }),
    script({ scriptName: 'Blank lines', findRegex: '/(\\s*\\n){3,}/g', replaceString: '\n\n' }),
    script({ scriptName: 'Disabled', findRegex: '/disabled/g', replaceString: 'X', disabled: true }),
    script({ scriptName: 'Reasoning steps', findRegex: '/^Step (\\d+):/gm', replaceString: '**Step $1:**', placement: [P.REASONING], markdownOnly: true }),
    script({ scriptName: 'World', findRegex: '/\\bWORLD\\b/g', replaceString: 'world', placement: [P.WI] }),
    script({ scriptName: 'Heart', findRegex: '/♥/g', replaceString: '❤', markdownOnly: true }),
    script({ scriptName: 'Emoji span', findRegex: '/\\p{Emoji_Presentation}+/gu', replaceString: '<span class="e">{{match}}</span>', markdownOnly: true }),
    script({ scriptName: 'Summary group', findRegex: '/(?:<summary>)([\\s\\S]*?)(?:<\\/summary>)/g', replaceString: '$1', markdownOnly: true, placement: [P.AI, P.SLASH] }),
    script({ scriptName: 'Headings', findRegex: '/^#+ (.*)$/gm', replaceString: '<h4>$1</h4>', markdownOnly: true }),
    script({ scriptName: 'Dice', findRegex: '/\\[roll\\]/g', replaceString: '{{random::1::2::3::4::5::6}}', markdownOnly: true }),
    script({ scriptName: 'Edit only', findRegex: '/TODO/g', replaceString: 'DONE', runOnEdit: false, placement: [P.AI, P.USER] }),
];

const msg = (name, isUser, mes, extra = {}) => ({ name, is_user: isUser, is_system: false, mes, extra });

export const CHAT = () => [
    msg('Dr. A (B)', false, 'Welcome, traveler. Dr. A (B) says hello.\n<status>HP 100 · Day 1</status>'),
    msg('User', true, 'User: **Hi!** I look around.   \nOOC: keep it short'),
    msg('Dr. A (B)', false, '<thinking>The user greets me.\nKeep it brief.</thinking>\nThe narrator nods. 「어서 오세요」 [HP: 90/100]\n\n\n\nBob waves ♥ [roll]', { reasoning: 'Step 1: read\nStep 2: answer' }),
    msg('User', true, '<br>안녕하세요! **반가워요** [note: "quiet"]  \t\nTODO: ask about the map'),
    { name: 'SillyTavern System', is_user: false, is_system: true, mes: 'System note: chat saved', extra: {} },
    msg('Dr. A (B)', false, '# Chapter 2\nThe WORLD shifts. 😀😀 <summary>Recap</summary>\n<img-prompt>castle at dusk</img-prompt>\n<status>HP 80 · Day 2</status> [HP: 80/100]'),
];
