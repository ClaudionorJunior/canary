// PreToolUse (Bash|PowerShell): pede confirmação antes de comando destrutivo.
//
// Por que este arquivo existe: o .claude/settings.json libera Bash e
// PowerShell por inteiro, para o Claude não pedir aprovação a cada comando.
// Sem este hook, nada fica entre o agente e um comando que destrói trabalho
// ou dados: um push forçado, um `reset --hard`, um `docker compose down -v`
// que apaga o banco com as contas.
//
// Ele não bloqueia: responde "ask", e o Claude Code mostra a tela de
// aprovação com o motivo. Na dúvida, também pergunta. Um falso positivo custa
// um clique; um falso negativo custa os dados.
//
// O stdout só pode ter o JSON da decisão, porque qualquer outra linha impede o
// Claude Code de ler a resposta. Sem decisão, o hook sai em silêncio e a regra
// "allow" do settings libera o comando.

// Comando composto chega inteiro numa string só. Cada trecho entre
// separadores é conferido sozinho, para a flag de um comando não contaminar o
// vizinho (`git push && rm -f x` não é push forçado). A divisão ignora aspas
// de propósito: partir demais só gera mais trechos para conferir.
function trechos(comando) {
    return comando.split(/&&|\|\||[;|&\n]/);
}

// Tira aspas e parênteses das pontas, para que `'rm` (de `sh -c 'rm -rf x'`)
// continue sendo `rm`.
function palavras(trecho) {
    return trecho
        .split(/\s+/)
        .map((p) => p.replace(/^["'`(]+|["'`)]+$/g, ''))
        .filter(Boolean);
}

// `C:\Program Files\Git\cmd\git.exe` e `/usr/bin/git` também são git.
function programa(palavra) {
    return palavra.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

// Cada ocorrência do programa no trecho, com as palavras que vêm depois.
// Pega também o programa aninhado: `docker exec x sh -c 'rm -rf /y'`.
function* chamadas(trecho, nomes) {
    const p = palavras(trecho);
    for (let i = 0; i < p.length; i++) {
        if (nomes.includes(programa(p[i]))) {
            yield p.slice(i + 1);
        }
    }
}

// Bloco de flags curtas com um traço só: `-uf` contém `f`.
function blocoCom(palavra, letras) {
    return /^-[a-zA-Z0-9]+$/.test(palavra) && [...letras].some((l) => palavra.includes(l));
}

// Pula as opções globais (`-C <dir>`, `-c chave=valor`, `--no-pager`) até o
// subcomando.
function subcomandoGit(args) {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-C' || args[i] === '-c') {
            i++;
            continue;
        }
        if (!args[i].startsWith('-')) {
            return [args[i], args.slice(i + 1)];
        }
    }
    return [null, []];
}

function motivoGit(sub, a) {
    const tem = (...flags) => a.some((p) => flags.includes(p));
    const bloco = (letras) => a.some((p) => blocoCom(p, letras));

    switch (sub) {
        case 'push':
            if (tem('--force', '--delete', '--mirror', '--prune') || bloco('fd')
                || a.some((p) => p.startsWith('--force-with-lease') || /^[+:]/.test(p))) {
                return 'git push forçado ou que apaga ref remota (--force, -f, +ref, --delete, :ref, --mirror, --prune).';
            }
            return null;
        case 'reset':
            return tem('--hard') ? 'git reset --hard descarta as mudanças não commitadas.' : null;
        case 'clean':
            return tem('--dry-run') || bloco('n') ? null : 'git clean apaga arquivos não versionados.';
        case 'branch':
            if (bloco('D') || ((tem('--delete') || bloco('d')) && (tem('--force') || bloco('f')))) {
                return 'git branch -D apaga a branch mesmo sem merge.';
            }
            return null;
        case 'checkout':
            if (tem('--', '.', '--force') || bloco('f')) {
                return 'git checkout com --, . ou -f descarta mudanças não commitadas.';
            }
            return null;
        case 'restore': {
            const soStage = (tem('--staged') || bloco('S')) && !(tem('--worktree') || bloco('W'));
            return soStage ? null : 'git restore no working tree descarta mudanças não commitadas.';
        }
        case 'stash':
            return a[0] === 'drop' || a[0] === 'clear' ? 'git stash drop/clear apaga o stash.' : null;
        default:
            return null;
    }
}

// Bash: `-r`, `-rf`, `-fR`, `--recursive`. PowerShell: `-r`, `-rec`,
// `-Recurse`, `-Recurse:$true`. cmd: `/s`. O teste do bloco curto aceita só as
// letras de opção do rm, para `-Force` (que tem um `r`) não contar.
function recursivo(p) {
    const nome = p.split(':')[0].toLowerCase();
    return p === '--recursive'
        || (/^-[fiIrRdv]+$/.test(p) && /[rR]/.test(p))
        || (nome.length > 1 && nome.startsWith('-r') && 'recurse'.startsWith(nome.slice(1)))
        || nome === '/s';
}

function motivoDoTrecho(t) {
    for (const a of chamadas(t, ['git'])) {
        const motivo = motivoGit(...subcomandoGit(a));
        if (motivo) {
            return motivo;
        }
    }
    for (const a of chamadas(t, ['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir'])) {
        if (a.some(recursivo)) {
            return 'Remoção recursiva de arquivos (rm -r, Remove-Item -Recurse, rd /s).';
        }
    }
    for (const a of chamadas(t, ['find'])) {
        if (a.includes('-delete')) {
            return 'find -delete apaga arquivos.';
        }
    }
    const apagaVolumes = (a) => a.includes('down') && a.some((p) => p === '-v' || p.startsWith('--volumes'));
    for (const a of chamadas(t, ['docker-compose'])) {
        if (apagaVolumes(a)) {
            return 'docker compose down -v apaga os volumes, inclusive o banco com as contas.';
        }
    }
    for (const a of chamadas(t, ['docker'])) {
        if (a.includes('compose') && apagaVolumes(a)) {
            return 'docker compose down -v apaga os volumes, inclusive o banco com as contas.';
        }
        const volume = a.indexOf('volume');
        if (volume >= 0 && ['rm', 'remove', 'prune'].includes(a[volume + 1])) {
            return 'docker volume rm/prune apaga volumes, inclusive o banco com as contas.';
        }
        const system = a.indexOf('system');
        if (system >= 0 && a[system + 1] === 'prune') {
            return 'docker system prune apaga containers, redes e imagens sem uso.';
        }
    }
    for (const a of chamadas(t, ['gh'])) {
        if (a[0] === 'repo' && a[1] === 'delete') {
            return 'gh repo delete apaga um repositório no GitHub.';
        }
    }
    return null;
}

// SQL é conferido por instrução (separada por `;`) no comando inteiro, para
// que um `WHERE` numa linha de baixo ainda conte para o seu `UPDATE`.
function motivoSql(comando) {
    for (const s of comando.split(';')) {
        if (/\bdrop\s+(table|database|schema)\b/i.test(s)
            || /\btruncate\s+(table\s+)?[`"']?\w/i.test(s)
            || /\bdelete\s+from\b/i.test(s)
            || (/\bupdate\s+\S+\s+set\b/i.test(s) && !/\bwhere\b/i.test(s))) {
            return 'SQL destrutivo (DROP, TRUNCATE, DELETE FROM ou UPDATE sem WHERE).';
        }
    }
    return null;
}

async function decide() {
    let entrada = '';
    process.stdin.setEncoding('utf8');
    for await (const pedaco of process.stdin) {
        entrada += pedaco;
    }

    let comando;
    try {
        comando = JSON.parse(entrada).tool_input.command;
    } catch {
        return 'Não consegui ler o comando para conferir se é destrutivo.';
    }
    if (typeof comando !== 'string' || !comando.trim()) {
        return 'O comando chegou vazio ou ilegível.';
    }

    try {
        for (const t of trechos(comando)) {
            const motivo = motivoDoTrecho(t);
            if (motivo) {
                return motivo;
            }
        }
        return motivoSql(comando);
    } catch {
        return 'Falha interna ao conferir o comando.';
    }
}

const motivo = await decide();
if (motivo) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: `[hook do canary] ${motivo}`,
        },
    }));
}
