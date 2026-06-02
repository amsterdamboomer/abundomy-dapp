/**
 * Minimale, correcte parser voor mysqldump `INSERT`-statements.
 *
 * Regex volstaat hier niet: de data bevat emoji's, ge-escapete CR/LF (`\r\n`),
 * apostrofs binnen strings en `;`/`(`/`)` binnen tekstvelden. Daarom een echte
 * char-voor-char tokenizer die mysqldump's escaping omkeert, zodat de waarden
 * exact terugkomen zoals ze in MySQL stonden (cruciaal voor de hash-validatie
 * in Fase 2 — de `hash`-kolom is `ascii_bin`).
 */

// mysqldump escape-sequences → echte tekens.
const ESCAPES = {
  n: '\n', r: '\r', t: '\t', b: '\b',
  0: '\0', Z: '\x1a', '\\': '\\', "'": "'", '"': '"',
}

/**
 * Parse alle rijen van één tabel uit een volledige SQL-dump.
 * @param {string} sql  De volledige dump-tekst.
 * @param {string} table  Tabelnaam (zonder backticks).
 * @returns {Array<Object>}  Rijen als kolomnaam→waarde objecten.
 */
export function parseTable(sql, table) {
  const rows = []
  // Vang de kolomlijst én de positie net na `VALUES`.
  const headerRe = new RegExp('INSERT INTO `' + table + '`\\s*\\(([^)]*)\\)\\s*VALUES', 'g')
  const n = sql.length
  let m

  while ((m = headerRe.exec(sql)) !== null) {
    const cols = m[1].split(',').map((c) => c.trim().replace(/^`|`$/g, ''))
    let i = headerRe.lastIndex

    // Lees value-tuples tot de afsluitende `;` van dit statement.
    while (i < n) {
      while (i < n && ' \n\r\t,'.includes(sql[i])) i++ // ruimte/komma tussen tuples
      if (i >= n || sql[i] === ';') break
      if (sql[i] !== '(') break
      i++ // sla '(' over

      const vals = []
      let field = ''
      let quoted = false
      let inStr = false
      const flush = () => {
        if (quoted) vals.push(field)
        else {
          const t = field.trim()
          vals.push(t === 'NULL' ? null : Number(t))
        }
        field = ''
        quoted = false
      }

      while (i < n) {
        const c = sql[i]
        if (inStr) {
          if (c === '\\') {
            const nx = sql[i + 1]
            field += nx in ESCAPES ? ESCAPES[nx] : nx
            i += 2
            continue
          }
          if (c === "'") {
            if (sql[i + 1] === "'") { field += "'"; i += 2; continue } // '' → '
            inStr = false
            i++
            continue
          }
          field += c
          i++
          continue
        }
        if (c === "'") { inStr = true; quoted = true; i++; continue }
        if (c === ',') { flush(); i++; continue }
        if (c === ')') { flush(); i++; break } // einde tuple
        if (' \n\r\t'.includes(c)) { i++; continue } // ruimte rond bare woorden
        field += c
        i++
      }

      const row = {}
      cols.forEach((col, idx) => { row[col] = vals[idx] })
      rows.push(row)
    }
    headerRe.lastIndex = i
  }

  return rows
}

/** Parse de tabellen die de dapp nodig heeft (de rest is statistiek/afleidbaar). */
export function parseDump(sql) {
  return {
    transactions: parseTable(sql, 'transactions'),
    users: parseTable(sql, 'users'),
    proposals: parseTable(sql, 'proposals'),
    lists: parseTable(sql, 'lists'),
    usersOld: parseTable(sql, 'users_old'),
  }
}
