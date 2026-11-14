import React, {useEffect, useRef, useState, type FormEvent, type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {
    Activity,
    ArrowDownToLine,
    ArrowLeft,
    ArrowRight,
    ArrowUpRight,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    CircleHelp,
    Clock3,
    FileCheck2,
    FileUp,
    Flag,
    History,
    LayoutGrid,
    LoaderCircle,
    LockKeyhole,
    LogOut,
    Menu,
    Search,
    Settings2,
    ShieldCheck,
    Trophy,
    Users,
    Waves,
    X,
} from 'lucide-react';
import './styles.css';

type Data = Record<string, any>;

async function api(path: string, init?: RequestInit) {
    const response = await fetch(`/api${path}`, {
        ...init,
        headers: {
            'X-Tempo-Request': '1',
            ...(init?.body && !(init.body instanceof FormData)
                ? {'Content-Type': 'application/json'}
                : {}),
            ...init?.headers,
        },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Laden mislukt.');
    return data;
}

function useData(path: string, revision = 0) {
    const [data, setData] = useState<any>(null),
        [error, setError] = useState('');
    useEffect(() => {
        let active = true;
        setError('');
        api(path)
            .then((d) => {
                if (active) setData(d);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [path, revision]);
    return {data, error};
}

const date = (value?: string | null, long = false) =>
    value
        ? new Intl.DateTimeFormat('nl-NL', {
            day: 'numeric',
            month: long ? 'long' : 'short',
            year: 'numeric',
        }).format(new Date(value))
        : 'Datum onbekend';
const time = (v: number | null) =>
    v == null
        ? '—'
        : `${Math.floor(v / 6000)}:${String(Math.floor(v / 100) % 60).padStart(2, '0')}.${String(v % 100).padStart(2, '0')}`;
const genderLabel: Record<string, string> = {M: 'Heren', F: 'Dames', X: 'Gemengd'};
const initials = (name: string) =>
    name
        .split(' ')
        .filter(Boolean)
        .filter((p, i) => i === 0 || p.length > 3)
        .slice(0, 2)
        .map((p) => p[0])
        .join('');

function Alert({children, error = false}: { children: ReactNode; error?: boolean }) {
    return (
        <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
            {children}
        </div>
    );
}

function Loading() {
    return (
        <div className="loading">
            <LoaderCircle className="spin" size={22}/> Even laden…
        </div>
    );
}

function ClubLogo({className = ''}: { className?: string }) {
    return (
        <img
            className={`club-logo ${className}`}
            src="/tempo-logo.png"
            alt="Zwemvereniging Tempo Valkenswaard"
            width={2091}
            height={2588}
            decoding="async"
        />
    );
}

function Badge({children, tone = ''}: { children: ReactNode; tone?: string }) {
    return <span className={`badge ${tone}`}>{children}</span>;
}

function Modal({
                   title,
                   children,
                   onClose,
               }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        ref.current?.showModal();
    }, []);
    return (
        <dialog
            ref={ref}
            aria-label={title}
            onCancel={onClose}
            onClick={(e) => {
                if (e.target === ref.current) onClose();
            }}
        >
            <div className="modal-head">
                <div>
                    <span className="eyebrow">TEMPO · RECORDARCHIEF</span>
                    <h2>{title}</h2>
                </div>
                <button className="icon-btn" onClick={onClose} aria-label="Sluiten">
                    <X/>
                </button>
            </div>
            {children}
        </dialog>
    );
}

function App() {
    const [page, setPage] = useState(location.hash.slice(1) || 'records');
    const [revision, setRevision] = useState(0),
        [menu, setMenu] = useState(false),
        [help, setHelp] = useState(false),
        [connected, setConnected] = useState(false);
    const {data: meta, error} = useData('/meta', revision);
    const [isMobile, setIsMobile] = useState(window.matchMedia('(max-width:760px)').matches);
    useEffect(() => {
        const media = window.matchMedia('(max-width:760px)');
        const onChange = () => setIsMobile(media.matches);
        media.addEventListener('change', onChange);
        return () => media.removeEventListener('change', onChange);
    }, []);
    useEffect(() => {
        const onHash = () => {
            setPage(location.hash.slice(1) || 'records');
            setMenu(false);
            window.scrollTo(0, 0);
        };
        window.addEventListener('hashchange', onHash);
        const stream = new EventSource('/api/events');
        stream.onopen = () => setConnected(true);
        stream.onerror = () => setConnected(false);
        stream.onmessage = () => setRevision((r) => r + 1);
        return () => {
            window.removeEventListener('hashchange', onHash);
            stream.close();
        };
    }, []);
    const nav = [
        ['records', 'Clubrecords', Trophy],
        ['results', 'Alle resultaten', Activity],
        ['swimmers', 'Zwemmers', Users],
    ] as const;
    return (
        <div className="app-shell">
            {menu && <div className="mobile-scrim" onClick={() => setMenu(false)}/>}
            <aside
                id="club-navigation"
                className={`sidebar ${menu ? 'is-open' : ''}`}
                inert={isMobile && !menu}
                aria-hidden={isMobile && !menu}
            >
                <a href="#records" className="brand" aria-label="Tempo Valkenswaard, clubrecords">
                    <ClubLogo/>
                </a>
                <div className="sidebar-label">HET CLUBARCHIEF 2</div>
                <nav>
                    {nav.map(([id, label, Icon]) => (
                        <a
                            className={page === id ? 'active' : ''}
                            href={`#${id}`}
                            key={id}
                            aria-current={page === id ? 'page' : undefined}
                        >
                            <Icon size={19}/>
                            {label}
                            {page === id && <span className="nav-dot"/>}
                        </a>
                    ))}
                </nav>
                <div className="sidebar-note">
                    <div className="mini-pool">
                        <span/>
                        <span/>
                        <span/>
                    </div>
                    <h4>Samen steeds sneller.</h4>
                    <p>
                        De prestaties van onze club.
                        <br/>
                        Van eerste start tot clubrecord.
                    </p>
                    <a href="https://www.zwemverenigingtempo.nl/" target="_blank" rel="noreferrer">
                        Naar de verenigingssite <ArrowUpRight size={14}/>
                    </a>
                </div>
                <div className="sidebar-bottom">
                    <button onClick={() => setHelp(true)}>
                        <CircleHelp size={18}/> Over de clubrecords
                    </button>
                    <a className={page === 'admin' ? 'active' : ''} href="#admin">
                        <ShieldCheck size={18}/> Beheeromgeving <ArrowUpRight size={15}/>
                    </a>
                    <div className="club-address">
                        <span className="tiny-dot"/> ZWEMVERENIGING TEMPO
                    </div>
                </div>
            </aside>
            <div className="main-shell">
                <header className="topbar">
                    <div>
                        <button
                            className="icon-btn mobile-menu"
                            onClick={() => setMenu(!menu)}
                            aria-label="Menu openen"
                            aria-expanded={menu}
                            aria-controls="club-navigation"
                        >
                            <Menu/>
                        </button>
                        <a href="#records" className="topbar-logo" aria-label="Tempo Valkenswaard, clubrecords">
                            <ClubLogo/>
                        </a>
                        <span className="topbar-club">Zwemvereniging Tempo</span>
                        <span className="topbar-divider">/</span>
                        <span>
              {page === 'admin'
                  ? 'Beheeromgeving'
                  : page === 'results'
                      ? 'Resultaten'
                      : page === 'swimmers'
                          ? 'Zwemmers'
                          : 'Clubrecords'}
            </span>
                    </div>
                    <span className="live-label">
            <span className={`live-dot ${connected ? '' : 'offline'}`}/>{' '}
                        {connected ? 'Live bijgewerkt' : 'Verbinding herstellen…'}
          </span>
                </header>
                <main>
                    {error ? (
                        <Alert error>{error}</Alert>
                    ) : !meta ? (
                        <Loading/>
                    ) : page === 'admin' ? (
                        <Admin meta={meta} revision={revision} refresh={() => setRevision((r) => r + 1)}/>
                    ) : page === 'swimmers' ? (
                        <Swimmers revision={revision}/>
                    ) : page === 'results' ? (
                        <Results meta={meta} revision={revision}/>
                    ) : (
                        <Records meta={meta} revision={revision}/>
                    )}
                </main>
                <footer>
                    <span>© {new Date().getFullYear()} Tempo Valkenswaard</span>
                    <span>
            Elke prestatie telt. <Waves size={17}/>
          </span>
                </footer>
            </div>
            {help && (
                <Modal title="Hoe werken de clubrecords?" onClose={() => setHelp(false)}>
                    <div className="prose">
                        <h3>Leeftijd in het wedstrijdjaar</h3>
                        <p>
                            De leeftijd is het wedstrijdjaar min het geboortejaar. Je verjaardag verandert de
                            categorie binnen dat jaar niet. Een zwemmer uit 2010 zwemt in heel 2026 in de
                            categorie 16 jaar.
                        </p>
                        <h3>Individueel, estafette en Masters</h3>
                        <p>
                            Er zijn categorieën voor 8 tot en met 16 jaar, senioren vanaf 17 jaar, alle leeftijden
                            en Masters vanaf 30 jaar in vijfjaarsgroepen. Een resultaat kan in meerdere
                            categorieën een record zijn.
                        </p>
                        <h3>Badlengte en tussentijden</h3>
                        <p>
                            Het oorspronkelijke recordboek maakt geen onderscheid tussen korte en lange baan.
                            Daarom vergelijken we clubrecords over badlengtes heen. De badlengte bij een resultaat
                            blijft zichtbaar. Officiële tussentijden bij vrije slag kunnen meetellen voor kortere
                            afstanden.
                        </p>
                        <h3>Een controleerbaar archief</h3>
                        <p>
                            Het Excel-bestand vormt het startpunt. De historie bevat die startrecords en de daarna
                            geïmporteerde wedstrijdresultaten; eerdere verbeteringen zijn niet volledig bekend.
                            Bij een gecorrigeerde wedstrijduitslag worden de records opnieuw berekend.
                        </p>
                        <p>
                            Bijzondere gemengde estafettes blijven aparte onderdelen. Zonder volledige
                            ploeggegevens wordt geen leeftijdsrecord toegekend.
                        </p>
                    </div>
                </Modal>
            )}
        </div>
    );
}

function Records({meta, revision}: { meta: Data; revision: number }) {
    const [type, setType] = useState('individual'),
        [stroke, setStroke] = useState(''),
        [gender, setGender] = useState(''),
        [category, setCategory] = useState('ALL'),
        [distance, setDistance] = useState(''),
        [q, setQ] = useState(''),
        [page, setPage] = useState(1),
        [selected, setSelected] = useState<Data | null>(null),
        [exporting, setExporting] = useState(false),
        [exportError, setExportError] = useState('');
    const params = new URLSearchParams({
        type,
        stroke,
        gender,
        category,
        distance,
        q,
        page: String(page),
    });
    const {data, error} = useData(`/records?${params}`, revision);
    const {data: recent} = useData('/history', revision);

    function update(setter: (v: any) => void, v: any) {
        setter(v);
        setPage(1);
    }

    async function exportCsv() {
        setExporting(true);
        setExportError('');
        try {
            const rows: Data[] = [];
            let p = 1,
                total = 1;
            while (rows.length < total) {
                const d = await api(
                    `/records?${new URLSearchParams({...Object.fromEntries(params), page: String(p++), limit: '100'})}`,
                );
                rows.push(...d.rows);
                total = d.total;
            }
            const escape = (s: any) =>
                `"${String(s ?? '')
                    .replace(/^[=+@-]/, "'$&")
                    .replaceAll('"', '""')}"`;
            const csv =
                '\ufeff' +
                [
                    ['Onderdeel', 'Categorie', 'Geslacht', 'Zwemmer', 'Tijd', 'Datum', 'Badlengte', 'Bron'],
                    ...rows.map((r) => [
                        r.event,
                        r.category,
                        genderLabel[r.gender],
                        r.swimmer_name,
                        r.time,
                        r.race_date || r.date_label,
                        r.course,
                        r.filename,
                    ]),
                ]
                    .map((r) => r.map(escape).join(';'))
                    .join('\r\n');
            const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8;'}));
            const a = document.createElement('a');
            a.href = url;
            a.download = 'tempo-clubrecords.csv';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            setExportError((e as Error).message);
        } finally {
            setExporting(false);
        }
    }

    const recentUnique = (recent || [])
        .filter((r: Data, i: number, a: Data[]) => a.findIndex((x) => x.id === r.id) === i)
        .slice(0, 3);
    return (
        <>
            <div className="page-heading">
                <div>
                    <div className="eyebrow">HET RECORDBOEK VAN TEMPO</div>
                    <h1>
                        Clubrecords<span className="heading-dot">.</span>
                    </h1>
                    <p>Bijzondere prestaties. Blijvende herinneringen.</p>
                </div>
                <button className="button secondary" onClick={exportCsv} disabled={exporting}>
                    <ArrowDownToLine size={17}/>
                    {exporting ? 'Exporteren…' : 'Exporteer CSV'}
                </button>
            </div>
            {exportError && <Alert error>{exportError}</Alert>}
            <section className="hero">
                <div className="hero-content">
          <span className="hero-kicker">
            <span/> VAN ONZE CLUB. VOOR DE GESCHIEDENIS.
          </span>
                    <h2>
                        Het beste
                        <br/>
                        van Tempo.
                    </h2>
                    <p>
                        Elke baan een nieuwe kans. Ontdek de snelste
                        <br className="desktop-break"/> tijden en de zwemmers achter de records.
                    </p>
                    <a
                        href="#recordbook"
                        onClick={(e) => {
                            e.preventDefault();
                            document.getElementById('recordbook')?.scrollIntoView({behavior: 'smooth'});
                        }}
                    >
                        Duik in het recordboek <ArrowRight size={17}/>
                    </a>
                </div>
                <div className="hero-art" aria-hidden="true">
                    <img className="hero-crest" src="/tempo-logo.png" alt="" width={2091} height={2588}/>
                    <div className="lane lane-1"/>
                    <div className="lane lane-2"/>
                    <div className="lane lane-3"/>
                    <div className="lane lane-4"/>
                    <div className="lane lane-5"/>
                    <span className="pool-distance">VALKENSWAARD · SINDS 1961</span>
                </div>
            </section>
            <div className="stats-grid">
                <Stat
                    icon={<Trophy/>}
                    value={meta.stats.records}
                    label="Clubrecords in het archief"
                    detail="Over alle categorieën"
                />
                <Stat
                    icon={<Users/>}
                    value={meta.stats.swimmers}
                    label="Zwemmers in het archief"
                    detail="Samen vormen we Tempo"
                />
                <Stat
                    icon={<Flag/>}
                    value={meta.stats.results}
                    label="Wedstrijdresultaten"
                    detail={`${meta.stats.meets} geïmporteerde wedstrijden`}
                />
                <Stat
                    icon={<CalendarDays/>}
                    value={meta.stats.lastImport ? date(meta.stats.lastImport) : 'Nog geen import'}
                    label="Laatste import"
                    detail="Records automatisch gecontroleerd"
                    small
                />
            </div>
            <section id="recordbook" className="recordbook">
                <div className="section-heading">
                    <div>
                        <h2>
                            Het recordboek <span>{data?.total ?? '…'}</span>
                        </h2>
                        <p>Vind een record op slag, afstand of categorie.</p>
                    </div>
                    <div className="segmented">
                        <button
                            className={type === 'individual' ? 'selected' : ''}
                            onClick={() => {
                                update(setType, 'individual');
                                if (gender === 'X') setGender('');
                                if (category.startsWith('MASTERS')) setCategory('ALL');
                            }}
                        >
                            Individueel
                        </button>
                        <button
                            className={type === 'relay' ? 'selected' : ''}
                            onClick={() => {
                                update(setType, 'relay');
                                if (category.startsWith('MASTERS')) setCategory('ALL');
                            }}
                        >
                            Estafette
                        </button>
                    </div>
                </div>
                <div className="stroke-tabs">
                    <button className={!stroke ? 'active' : ''} onClick={() => update(setStroke, '')}>
                        Alle slagen
                    </button>
                    {meta.strokes
                        .filter((s: Data) => s.code !== 'IMRELAY')
                        .map((s: Data) => (
                            <button
                                key={s.code}
                                className={stroke === s.code ? 'active' : ''}
                                onClick={() => update(setStroke, s.code)}
                            >
                                {s.name}
                            </button>
                        ))}
                </div>
                <div className="filters">
                    <label className="search-box">
                        <Search size={17}/>
                        <input
                            aria-label="Zoek zwemmer of wedstrijd"
                            placeholder="Zoek een zwemmer…"
                            value={q}
                            onChange={(e) => update(setQ, e.target.value)}
                        />
                        {q && (
                            <button aria-label="Zoekopdracht wissen" onClick={() => update(setQ, '')}>
                                <X size={15}/>
                            </button>
                        )}
                    </label>
                    <Select label="Geslacht" value={gender} onChange={(v) => update(setGender, v)}>
                        <option value="">Dames & heren{type === 'relay' ? ' & gemengd' : ''}</option>
                        <option value="M">Heren</option>
                        <option value="F">Dames</option>
                        {type === 'relay' && <option value="X">Gemengd</option>}
                    </Select>
                    <Select label="Categorie" value={category} onChange={(v) => update(setCategory, v)}>
                        <option value="">Alle categorieën</option>
                        {meta.categories
                            .filter((c: Data) => type !== 'relay' || c.kind !== 'masters')
                            .map((c: Data) => (
                                <option key={c.code} value={c.code}>
                                    {c.name}
                                </option>
                            ))}
                    </Select>
                    <Select label="Afstand" value={distance} onChange={(v) => update(setDistance, v)}>
                        <option value="">Alle afstanden</option>
                        {meta.distances.map((d: Data) => (
                            <option key={d.meters} value={d.meters}>
                                {d.meters} meter{type === 'relay' ? ' per zwemmer' : ''}
                            </option>
                        ))}
                    </Select>
                </div>
                {error ? (
                    <Alert error>{error}</Alert>
                ) : !data ? (
                    <Loading/>
                ) : (
                    <>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                <tr>
                                    <th>ONDERDEEL</th>
                                    <th>RECORDHOUDER</th>
                                    <th>TIJD</th>
                                    <th>CATEGORIE</th>
                                    <th>GEZWOMMEN OP</th>
                                    <th aria-label="Historie"/>
                                </tr>
                                </thead>
                                <tbody>
                                {data.rows.map((r: Data) => (
                                    <tr key={`${r.slot_id}-${r.id}`}>
                                        <td>
                                            <div className="event-name">
                                                {r.relay_count > 1 ? `${r.relay_count} × ` : ''}
                                                {r.meters}m <span>{r.stroke_name}</span>
                                            </div>
                                            <small>
                                                {genderLabel[r.gender]}
                                                {r.variant ? ' · Bijzondere samenstelling' : ''}
                                            </small>
                                        </td>
                                        <td>
                                            <button className="person-link" onClick={() => setSelected(r)}>
                          <span className={`avatar ${r.gender === 'F' ? 'rose' : ''}`}>
                            {r.relay_count > 1 ? <Users size={16}/> : initials(r.swimmer_name)}
                          </span>
                                                <span>
                            {r.swimmer_name}
                                                    {r.source_kind === 'split' && <small>Officiële tussentijd</small>}
                          </span>
                                            </button>
                                        </td>
                                        <td className="record-time">{r.time}</td>
                                        <td>
                                            <Badge tone={r.category_code.startsWith('MASTERS') ? 'sand' : ''}>
                                                {r.category}
                                            </Badge>
                                        </td>
                                        <td className="date-cell">
                                            {r.race_date ? date(r.race_date) : r.date_label || 'Onbekend'}
                                            <small>
                                                {r.course === 'UNKNOWN'
                                                    ? 'Badlengte onbekend'
                                                    : r.course === 'SCM'
                                                        ? '25 meter'
                                                        : r.course === 'LCM'
                                                            ? '50 meter'
                                                            : r.course}
                                            </small>
                                        </td>
                                        <td>
                                            <button
                                                className="row-arrow"
                                                title="Bekijk de recordhistorie"
                                                onClick={() => setSelected(r)}
                                                aria-label={`Recordhistorie ${r.event} ${r.swimmer_name}`}
                                            >
                                                <ArrowUpRight size={18}/>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                            {!data.rows.length && (
                                <Empty
                                    title="Geen records gevonden"
                                    text="Probeer een andere slag, categorie of zoekopdracht."
                                />
                            )}
                        </div>
                        <Pagination data={data} onPage={setPage}/>
                    </>
                )}
                <div className="table-note">
                    <CircleHelp size={15}/>
                    <span>
            Leeftijd = wedstrijdjaar − geboortejaar. Korte en lange baan worden samen vergeleken.
          </span>
                    <span className="table-note-end">
            <span className="tiny-dot"/> Actueel recordarchief
          </span>
                </div>
            </section>
            {recentUnique.length > 0 && (
                <section className="recent-section">
                    <div className="section-heading">
                        <div>
                            <span className="eyebrow">UIT DE WEDSTRIJDEN</span>
                            <h2>Recente recordprestaties</h2>
                        </div>
                        <a className="text-link" href="#results">
                            Alle resultaten <ArrowRight size={16}/>
                        </a>
                    </div>
                    <div className="recent-grid">
                        {recentUnique.map((r: Data) => (
                            <button className="recent-card" key={r.id} onClick={() => setSelected(r)}>
                <span className="recent-icon">
                  <Trophy size={19}/>
                </span>
                                <div>
                                    <small>
                                        {date(r.race_date)} · {r.category}
                                    </small>
                                    <h3>{r.swimmer_name}</h3>
                                    <p>{r.event}</p>
                                </div>
                                <strong>
                                    {r.time}
                                    <ArrowUpRight size={15}/>
                                </strong>
                            </button>
                        ))}
                    </div>
                </section>
            )}
            {selected && (
                <RecordHistory record={selected} revision={revision} onClose={() => setSelected(null)}/>
            )}
        </>
    );
}

function Stat({
                  icon,
                  value,
                  label,
                  detail,
                  small = false,
              }: {
    icon: ReactNode;
    value: any;
    label: string;
    detail: string;
    small?: boolean;
}) {
    return (
        <div className="stat">
            <div className="stat-top">
                <span>{icon}</span>
                <ArrowUpRight size={15}/>
            </div>
            <strong className={small ? 'small-value' : ''}>
                {typeof value === 'number' ? value.toLocaleString('nl-NL') : value}
            </strong>
            <span className="stat-label">{label}</span>
            <small>{detail}</small>
        </div>
    );
}

function Select({
                    label,
                    value,
                    onChange,
                    children,
                }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    children: ReactNode;
}) {
    return (
        <label className="select-wrap">
            <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
                {children}
            </select>
            <ChevronDown size={14}/>
        </label>
    );
}

function Pagination({data, onPage}: { data: Data; onPage: (page: number) => void }) {
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    return (
        <div className="pagination">
      <span>
        {data.total
            ? `${(data.page - 1) * data.limit + 1}–${Math.min(data.total, data.page * data.limit)} van ${data.total} prestaties`
            : '0 prestaties'}
      </span>
            <div>
                <button
                    className="icon-btn"
                    disabled={data.page <= 1}
                    onClick={() => onPage(data.page - 1)}
                    aria-label="Vorige pagina"
                >
                    <ChevronLeft size={17}/>
                </button>
                <span>
          Pagina {data.page} van {pages}
        </span>
                <button
                    className="icon-btn"
                    disabled={data.page >= pages}
                    onClick={() => onPage(data.page + 1)}
                    aria-label="Volgende pagina"
                >
                    <ChevronRight size={17}/>
                </button>
            </div>
        </div>
    );
}

function Empty({title, text}: { title: string; text: string }) {
    return (
        <div className="empty">
            <Waves size={32}/>
            <h3>{title}</h3>
            <p>{text}</p>
        </div>
    );
}

function RecordHistory({
                           record,
                           revision,
                           onClose,
                       }: {
    record: Data;
    revision: number;
    onClose: () => void;
}) {
    const {data, error} = useData(`/records/${record.slot_id}/history`, revision);
    return (
        <Modal title={record.event} onClose={onClose}>
            <div className="history-summary">
                <Badge>{record.category}</Badge>
                <span>{genderLabel[record.gender]}</span>
                {record.variant && <p>{record.variant}</p>}
            </div>
            <p className="modal-intro">
                Van startrecord tot de laatste verbetering. Gelijke tijden delen het record.
            </p>
            {error ? (
                <Alert error>{error}</Alert>
            ) : !data ? (
                <Loading/>
            ) : (
                <div className="timeline">
                    {data.map((r: Data) => (
                        <div className="timeline-entry" key={r.id}>
                            <span className={`timeline-dot ${r.is_current ? 'current' : ''}`}/>
                            <div>
                                <small>
                                    {r.race_date ? date(r.race_date, true) : r.date_label || 'Datum onbekend'}
                                </small>
                                <div className="timeline-main">
                                    <strong>{r.swimmer_name}</strong>
                                    <b>{r.time}</b>
                                </div>
                                <p>
                                    {r.source_kind === 'seed' ? 'Startrecord uit Excel' : r.meet_name}
                                    {r.city ? ` · ${r.city}` : ''}
                                </p>
                                <div className="timeline-badges">
                                    {r.is_current ? <Badge>Huidig record</Badge> : null}
                                    {r.change_type === 'equal' ? (
                                        <Badge tone="sand">Geëvenaard</Badge>
                                    ) : r.previous_time_cs ? (
                                        <span>{((r.previous_time_cs - r.time_cs) / 100).toFixed(2)} sec sneller</span>
                                    ) : (
                                        <span>
                      {r.source_kind === 'seed' ? 'Historisch startpunt' : 'Eerste bekende tijd'}
                    </span>
                                    )}
                                </div>
                                {r.members.length > 0 && (
                                    <p className="relay-names">{r.members.map((m: Data) => m.name).join(' · ')}</p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            <div className="modal-foot">
                <History size={15}/> Historie vóór het Excel-startrecord is niet volledig beschikbaar.
            </div>
        </Modal>
    );
}

function Results({
                     meta,
                     revision,
                     swimmerId,
                     onBack,
                 }: {
    meta: Data;
    revision: number;
    swimmerId?: number;
    onBack?: () => void;
}) {
    const [q, setQ] = useState(''),
        [stroke, setStroke] = useState(''),
        [course, setCourse] = useState(''),
        [page, setPage] = useState(1),
        [selected, setSelected] = useState<Data | null>(null);
    const {data, error} = useData(
        `/results?${new URLSearchParams({
            q,
            stroke,
            course,
            page: String(page), ...(swimmerId ? {swimmer: String(swimmerId)} : {})
        })}`,
        revision,
    );
    return (
        <>
            {onBack && (
                <button className="text-link back" onClick={onBack}>
                    <ArrowLeft size={16}/> Alle zwemmers
                </button>
            )}
            <div className="page-heading">
                <div>
                    <div className="eyebrow">VAN START TOT FINISH</div>
                    <h1>
                        {swimmerId ? 'Zwemmerresultaten' : 'Alle resultaten'}
                        <span className="heading-dot">.</span>
                    </h1>
                    <p>Alle Tempo-prestaties, inclusief tussentijden en diskwalificaties.</p>
                </div>
                <span className="outlined-label">
          <Activity size={16}/> Het wedstrijdarchief
        </span>
            </div>
            <section className="panel">
                <div className="filters">
                    <label className="search-box">
                        <Search size={17}/>
                        <input
                            aria-label="Zoek zwemmer of wedstrijd"
                            placeholder="Zoek zwemmer of wedstrijd…"
                            value={q}
                            onChange={(e) => {
                                setQ(e.target.value);
                                setPage(1);
                            }}
                        />
                    </label>
                    <Select
                        label="Zwemslag"
                        value={stroke}
                        onChange={(v) => {
                            setStroke(v);
                            setPage(1);
                        }}
                    >
                        <option value="">Alle slagen</option>
                        {meta.strokes.map((s: Data) => (
                            <option value={s.code} key={s.code}>
                                {s.name}
                            </option>
                        ))}
                    </Select>
                    <Select
                        label="Badlengte"
                        value={course}
                        onChange={(v) => {
                            setCourse(v);
                            setPage(1);
                        }}
                    >
                        <option value="">Alle badlengtes</option>
                        <option value="SCM">25 meter</option>
                        <option value="LCM">50 meter</option>
                        <option value="UNKNOWN">Onbekend (Excel)</option>
                    </Select>
                </div>
                {error ? (
                    <Alert error>{error}</Alert>
                ) : !data ? (
                    <Loading/>
                ) : (
                    <>
                        <div className="table-wrap">
                            <table>
                                <thead>
                                <tr>
                                    <th>ZWEMMER</th>
                                    <th>ONDERDEEL</th>
                                    <th>TIJD</th>
                                    <th>WEDSTRIJD</th>
                                    <th>DATUM</th>
                                    <th/>
                                </tr>
                                </thead>
                                <tbody>
                                {data.rows.map((r: Data) => (
                                    <tr key={r.id}>
                                        <td>
                                            <button className="person-link" onClick={() => setSelected(r)}>
                          <span className={`avatar ${r.gender === 'F' ? 'rose' : ''}`}>
                            {initials(r.swimmer_name)}
                          </span>
                                                {r.swimmer_name}
                                            </button>
                                        </td>
                                        <td>
                                            <div className="event-name">
                                                {r.relay_count > 1 ? `${r.relay_count} × ` : ''}
                                                {r.meters}m <span>{r.stroke_name}</span>
                                            </div>
                                            <small>
                                                {r.course === 'SCM'
                                                    ? '25m bad'
                                                    : r.course === 'LCM'
                                                        ? '50m bad'
                                                        : 'Badlengte onbekend'}
                                                {r.round ? ` · ${r.round}` : ''}
                                            </small>
                                        </td>
                                        <td>
                                            <span className="result-time">{r.status === 'OK' ? r.time : r.status}</span>
                                            {r.is_record ? (
                                                <small className="record-tag">
                                                    <Trophy size={11}/> Clubrecord
                                                </small>
                                            ) : null}
                                        </td>
                                        <td className="meet-cell">
                                            {r.meet_name || 'Historisch startrecord'}
                                            <small>{r.city || 'Excel-recordboek'}</small>
                                        </td>
                                        <td className="date-cell">
                                            {r.race_date ? date(r.race_date) : r.date_label || 'Onbekend'}
                                        </td>
                                        <td>
                                            <button
                                                className="row-arrow"
                                                onClick={() => setSelected(r)}
                                                aria-label={`Details ${r.swimmer_name} ${r.event}`}
                                            >
                                                <ArrowUpRight size={18}/>
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                                </tbody>
                            </table>
                            {!data.rows.length && (
                                <Empty
                                    title="Geen resultaten gevonden"
                                    text="Pas de filters aan of importeer een wedstrijdbestand via Beheer."
                                />
                            )}
                        </div>
                        <Pagination data={data} onPage={setPage}/>
                    </>
                )}
            </section>
            {selected && <ResultDetail result={selected} onClose={() => setSelected(null)}/>}
        </>
    );
}

function ResultDetail({result: r, onClose}: { result: Data; onClose: () => void }) {
    const {data} = useData(`/results/${r.id}/splits`);
    return (
        <Modal title={r.swimmer_name} onClose={onClose}>
            <div className="result-hero">
                <span>{r.event}</span>
                <strong>{r.status === 'OK' ? r.time : r.status}</strong>
                <Badge>
                    {r.course === 'SCM' ? '25 meter' : r.course === 'LCM' ? '50 meter' : 'Badlengte onbekend'}
                </Badge>
            </div>
            <div className="prose">
                <h3>{r.meet_name || 'Startrecord uit Excel'}</h3>
                <p>
                    {r.race_date ? date(r.race_date, true) : r.date_label || 'Exacte datum onbekend'}
                    {r.city ? ` · ${r.city}` : ''}
                </p>
                {r.comment && <Alert>{r.comment}</Alert>}
                {r.members.length > 0 && (
                    <>
                        <h3>De estafetteploeg</h3>
                        <p>{r.members.map((m: Data) => m.name).join(' · ')}</p>
                    </>
                )}
                {data?.length > 0 && (
                    <>
                        <h3>Tussentijden (cumulatief)</h3>
                        <div className="split-grid">
                            {data.map((s: Data) => (
                                <div key={s.distance}>
                                    <span>{s.distance} meter</span>
                                    <strong>{time(s.time_cs)}</strong>
                                </div>
                            ))}
                        </div>
                    </>
                )}
                <p className="source-caption">Bron: {r.filename}</p>
            </div>
        </Modal>
    );
}

function Swimmers({revision}: { revision: number }) {
    const [q, setQ] = useState(''),
        [selected, setSelected] = useState<number | null>(null);
    const {data, error} = useData(`/swimmers?${new URLSearchParams({q})}`, revision);
    const {data: meta} = useData('/meta', revision);
    if (selected && meta)
        return (
            <Results
                meta={meta}
                revision={revision}
                swimmerId={selected}
                onBack={() => setSelected(null)}
            />
        );
    return (
        <>
            <div className="page-heading">
                <div>
                    <span className="eyebrow">DE MENSEN ACHTER DE TIJDEN</span>
                    <h1>
                        Onze zwemmers<span className="heading-dot">.</span>
                    </h1>
                    <p>Een club vol talent. Ontdek hun prestaties.</p>
                </div>
                <span className="outlined-label">
          <Users size={16}/>
                    {data?.length || 0} zwemmers
        </span>
            </div>
            <label className="search-box swimmer-search">
                <Search size={18}/>
                <input
                    placeholder="Zoek een zwemmer…"
                    aria-label="Zoek een zwemmer"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                />
            </label>
            {error ? (
                <Alert error>{error}</Alert>
            ) : !data ? (
                <Loading/>
            ) : (
                <div className="swimmer-grid">
                    {data.map((s: Data) => (
                        <button className="swimmer-card" key={s.id} onClick={() => setSelected(s.id)}>
              <span className={`avatar large ${s.gender === 'F' ? 'rose' : ''}`}>
                {initials(s.name)}
              </span>
                            <ArrowUpRight size={18}/>
                            <h3>{s.name}</h3>
                            <p>{genderLabel[s.gender]}</p>
                            <div>
                <span>
                  <Trophy size={14}/>
                  <strong>{s.record_count}</strong> records
                </span>
                                <span>{s.result_count} resultaten</span>
                            </div>
                        </button>
                    ))}
                </div>
            )}
            {data?.length === 0 && (
                <Empty title="Geen zwemmers gevonden" text="Probeer een andere naam."/>
            )}
        </>
    );
}

function Admin({meta, revision, refresh}: { meta: Data; revision: number; refresh: () => void }) {
    const {data: auth, error: authError} = useData('/auth', revision);
    const [password, setPassword] = useState(''),
        [error, setError] = useState(''),
        [busy, setBusy] = useState(false),
        [summary, setSummary] = useState<Data | null>(null),
        [tab, setTab] = useState('uploads');

    async function login(e: FormEvent) {
        e.preventDefault();
        setError('');
        setBusy(true);
        try {
            await api('/login', {method: 'POST', body: JSON.stringify({password})});
            setPassword('');
            refresh();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    async function upload(file: File) {
        setError('');
        setSummary(null);
        setBusy(true);
        try {
            const form = new FormData();
            form.append('file', file);
            const s = await api('/admin/uploads', {method: 'POST', body: form});
            setSummary(s);
            refresh();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    if (authError) return <Alert error>{authError}</Alert>;
    if (!auth) return <Loading/>;
    if (!auth.authenticated)
        return (
            <div className="login-layout">
                <div className="login-art">
                    <ClubLogo className="login-crest"/>
                    <span className="eyebrow">TEMPO VALKENSWAARD</span>
                    <h1>
                        Een actueel
                        <br/>
                        recordboek begint hier.
                    </h1>
                    <p>Upload wedstrijduitslagen. Wij controleren de records.</p>
                    <div className="login-lines"/>
                </div>
                <form className="login-form" onSubmit={login}>
          <span className="login-lock">
            <LockKeyhole size={24}/>
          </span>
                    <h2>Welkom terug</h2>
                    <p>Log in om het clubarchief te beheren.</p>
                    {!auth.configured ? (
                        <Alert>
                            Stel eerst een beheerwachtwoord in via de terminal:
                            <code>npm run cli -- admin:set-password</code>
                        </Alert>
                    ) : (
                        <>
                            <label>
                                Beheerwachtwoord
                                <input
                                    type="password"
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    required
                                    placeholder="Je wachtwoord"
                                />
                            </label>
                            {error && <Alert error>{error}</Alert>}
                            <button className="button primary" disabled={busy}>
                                {busy ? <LoaderCircle className="spin" size={17}/> : <LockKeyhole size={17}/>}{' '}
                                Inloggen
                            </button>
                        </>
                    )}
                    <a href="#records" className="text-link">
                        <ArrowLeft size={16}/> Terug naar de clubrecords
                    </a>
                </form>
            </div>
        );
    return (
        <>
            <div className="page-heading">
                <div>
                    <span className="eyebrow">HET ARCHIEF IN GOEDE HANDEN</span>
                    <h1>
                        Beheeromgeving<span className="heading-dot">.</span>
                    </h1>
                    <p>Van wedstrijduitslag naar een bijgewerkt recordboek.</p>
                </div>
                <button
                    className="button secondary"
                    onClick={async () => {
                        await api('/logout', {method: 'POST'});
                        refresh();
                    }}
                >
                    <LogOut size={16}/> Uitloggen
                </button>
            </div>
            <div className="admin-tabs">
                <button className={tab === 'uploads' ? 'active' : ''} onClick={() => setTab('uploads')}>
                    <FileUp size={17}/> Bestandsimports
                </button>
                <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
                    <Settings2 size={17}/> Instellingen
                </button>
            </div>
            {tab === 'settings' ? (
                <Settings meta={meta} refresh={refresh}/>
            ) : (
                <>
                    <div className="admin-import-layout">
                        <section className="panel upload-panel">
                            <div className="section-heading">
                                <div>
                                    <h2>Nieuwe wedstrijduitslagen</h2>
                                    <p>Upload het volledige LENEX-uitslagenbestand.</p>
                                </div>
                                <Badge>Clubcode {meta.teamCode}</Badge>
                            </div>
                            <UploadZone onFile={upload} busy={busy}/>
                            {error && <Alert error>{error}</Alert>}
                            {summary && (
                                <Alert>
                                    {summary.duplicate ? (
                                        <>
                                            <Check size={17}/> Dit bestand is al verwerkt. Er is niets gewijzigd.
                                        </>
                                    ) : (
                                        <>
                                            <Check size={17}/>
                                            <strong>{summary.results} resultaten
                                                opgeslagen.</strong> {summary.newRecords}{' '}
                                            nieuwe recordtoekenningen.
                                            {summary.replacedMeets > 0 &&
                                                ` ${summary.replacedMeets} eerdere wedstrijdversie(s) vervangen.`}
                                        </>
                                    )}
                                </Alert>
                            )}
                            {summary && summary.warnings.length > 0 && (
                                <details className="import-warnings">
                                    <summary>{summary.warnings.length} aandachtspunt(en) bij deze import</summary>
                                    {summary.warnings.map((w: string, i: number) => (
                                        <p key={i}>{w}</p>
                                    ))}
                                </details>
                            )}
                        </section>
                        <aside className="import-info">
              <span className="info-icon">
                <ShieldCheck size={24}/>
              </span>
                            <h3>Een zorgvuldig archief</h3>
                            <div>
                                <span>01</span>
                                <p>
                                    Alleen resultaten van clubcode <strong>{meta.teamCode}</strong> worden opgeslagen.
                                </p>
                            </div>
                            <div>
                                <span>02</span>
                                <p>
                                    Dezelfde wedstrijd opnieuw uploaden vervangt de actieve versie. Gebruik steeds
                                    een{' '}
                                    <strong>volledige export</strong>.
                                </p>
                            </div>
                            <div>
                                <span>03</span>
                                <p>
                                    Records worden opnieuw berekend. Eerdere bestanden blijven bewaard voor controle.
                                </p>
                            </div>
                        </aside>
                    </div>
                    <UploadHistory revision={revision}/>
                </>
            )}
        </>
    );
}

function UploadZone({onFile, busy}: { onFile: (f: File) => void; busy: boolean }) {
    const input = useRef<HTMLInputElement>(null),
        [drag, setDrag] = useState(false);
    return (
        <div
            className={`upload-zone ${drag ? 'dragging' : ''}`}
            onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (e.dataTransfer.files[0] && !busy) onFile(e.dataTransfer.files[0]);
            }}
        >
      <span className="upload-symbol">
        {busy ? <LoaderCircle size={27} className="spin"/> : <FileUp size={27}/>}
      </span>
            <h3>{busy ? 'Resultaten verwerken…' : 'Sleep je wedstrijdbestand hierheen'}</h3>
            <p>LXF, LEF of XML · maximaal 10 MB</p>
            <button className="button primary" disabled={busy} onClick={() => input.current?.click()}>
                Kies een bestand <ArrowUpRight size={16}/>
            </button>
            <input
                ref={input}
                type="file"
                accept=".lxf,.lef,.xml"
                aria-label="Kies LENEX-bestand"
                hidden
                onChange={(e) => {
                    if (e.target.files?.[0]) onFile(e.target.files[0]);
                    e.target.value = '';
                }}
            />
        </div>
    );
}

function UploadHistory({revision}: { revision: number }) {
    const {data, error} = useData('/admin/uploads', revision);
    return (
        <section className="panel upload-history">
            <div className="section-heading">
                <div>
                    <h2>Importgeschiedenis</h2>
                    <p>Elke upload bewaard. Elke versie terug te vinden.</p>
                </div>
                <History size={21}/>
            </div>
            {error ? (
                <Alert error>{error}</Alert>
            ) : !data ? (
                <Loading/>
            ) : (
                <div className="upload-list">
                    {data.map((u: Data) => (
                        <div className="upload-item" key={u.id}>
              <span className={`file-icon ${u.kind === 'excel' ? 'excel' : ''}`}>
                <FileCheck2 size={22}/>
              </span>
                            <div className="upload-file">
                                <strong>{u.filename}</strong>
                                <p>{u.meet_names || 'Historische clubrecords · Excel-startbestand'}</p>
                                <small>
                                    {date(u.created_at)} · {u.result_count} resultaten · Club {u.team_code}
                                </small>
                                {u.warnings.length > 0 && (
                                    <details className="import-warnings">
                                        <summary>{u.warnings.length} bronopmerking(en)</summary>
                                        {u.warnings.map((w: string, i: number) => (
                                            <p key={i}>{w}</p>
                                        ))}
                                    </details>
                                )}
                            </div>
                            <Badge tone={u.kind === 'excel' ? 'sand' : u.active_meets ? '' : 'muted'}>
                                {u.kind === 'excel'
                                    ? 'Startbestand'
                                    : u.active_meets === u.total_meets
                                        ? 'Actief'
                                        : u.active_meets
                                            ? 'Deels vervangen'
                                            : 'Vervangen'}
                            </Badge>
                            <a
                                className="icon-btn"
                                href={`/api/admin/uploads/${u.id}/download`}
                                title="Download origineel"
                                aria-label={`Download ${u.filename}`}
                            >
                                <ArrowDownToLine size={18}/>
                            </a>
                        </div>
                    ))}
                    {!data.length && (
                        <Empty
                            title="Het archief is klaar voor de eerste import"
                            text="Laad de Excel via de CLI en upload daarna een LENEX-bestand."
                        />
                    )}
                </div>
            )}
        </section>
    );
}

function Settings({meta, refresh}: { meta: Data; refresh: () => void }) {
    const [team, setTeam] = useState(meta.teamCode),
        [saved, setSaved] = useState(false),
        [error, setError] = useState('');

    async function save(e: FormEvent) {
        e.preventDefault();
        setError('');
        setSaved(false);
        try {
            await api('/admin/settings', {method: 'PUT', body: JSON.stringify({teamCode: team})});
            setSaved(true);
            refresh();
        } catch (e) {
            setError((e as Error).message);
        }
    }

    return (
        <section className="panel settings-panel">
            <h2>Verenigingsinstellingen</h2>
            <p>De clubcode bepaalt welke zwemmers bij een import worden meegenomen.</p>
            <form onSubmit={save}>
                <label>
                    LENEX-clubcode
                    <input
                        value={team}
                        onChange={(e) => {
                            setTeam(e.target.value);
                            setSaved(false);
                        }}
                        pattern="[0-9]{2}-[0-9]{3}"
                        required
                    />
                </label>
                <p className="field-hint">
                    Standaard voor Tempo Valkenswaard: 13-036. Geldt voor volgende imports; bestaande uploads
                    behouden hun oorspronkelijke clubcode.
                </p>
                {error && <Alert error>{error}</Alert>}
                {saved && (
                    <Alert>
                        <Check size={16}/> Instellingen opgeslagen.
                    </Alert>
                )}
                <button className="button primary">
                    Wijzigingen opslaan <Check size={16}/>
                </button>
            </form>
            <div className="settings-rule">
                <h3>Leeftijdsberekening</h3>
                <p>
                    Wedstrijdjaar − geboortejaar. Senioren vanaf 17 jaar; Masters vanaf 30 jaar in
                    vijfjaarsgroepen.
                </p>
                <h3>Recordvergelijking</h3>
                <p>
                    Korte en lange baan worden samen vergeleken, overeenkomstig het Excel-startbestand. De
                    badlengte wordt afzonderlijk opgeslagen.
                </p>
                <h3>Beheerwachtwoord wijzigen</h3>
                <p>
                    Voer op de server uit: <code>npm run cli -- admin:set-password</code>. Alle bestaande
                    beheersessies worden daarna beëindigd.
                </p>
            </div>
        </section>
    );
}

createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
        <App/>
    </React.StrictMode>,
);
