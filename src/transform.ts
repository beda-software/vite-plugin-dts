import { dirname, isAbsolute, relative, resolve } from 'node:path'

import MagicString from 'magic-string'
import ts from 'typescript'
import { isRegExp, normalizePath } from './utils'

import type { Alias } from 'vite'

const globSuffixRE = /^((?:.*\.[^.]+)|(?:\*+))$/

export function normalizeGlob(path: string) {
  if (/[\\/]$/.test(path)) {
    return path + '**'
  } else if (!globSuffixRE.test(path.split(/[\\/]/).pop()!)) {
    return path + '/**'
  }

  return path
}

function walkSourceFile(
  sourceFile: ts.SourceFile,
  callback: (node: ts.Node, parent: ts.Node) => void | boolean
) {
  function walkNode(
    node: ts.Node,
    parent: ts.Node,
    callback: (node: ts.Node, parent: ts.Node) => void | boolean
  ) {
    if (callback(node, parent) !== false) {
      node.forEachChild(child => walkNode(child, node, callback))
    }
  }

  sourceFile.forEachChild(child => walkNode(child, sourceFile, callback))
}

function isAliasMatch(alias: Alias, importer: string) {
  if (isRegExp(alias.find)) return alias.find.test(importer)
  if (importer.length < alias.find.length) return false
  if (importer === alias.find) return true

  return (
    importer.indexOf(alias.find) === 0 &&
    (alias.find.endsWith('/') || importer.substring(alias.find.length)[0] === '/')
  )
}

function transformAlias(
  importer: string,
  dir: string,
  aliases: Alias[],
  aliasesExclude: (string | RegExp)[]
) {
  if (
    aliases.length &&
    !aliasesExclude.some(e => (isRegExp(e) ? e.test(importer) : String(e) === importer))
  ) {
    const matchedAlias = aliases.find(alias => isAliasMatch(alias, importer))

    if (matchedAlias) {
      const replacement = isAbsolute(matchedAlias.replacement)
        ? normalizePath(relative(dir, matchedAlias.replacement))
        : normalizePath(matchedAlias.replacement)

      const endsWithSlash =
        typeof matchedAlias.find === 'string'
          ? matchedAlias.find.endsWith('/')
          : importer.match(matchedAlias.find)![0].endsWith('/')
      const truthPath = importer.replace(
        matchedAlias.find,
        replacement + (endsWithSlash ? '/' : '')
      )
      const normalizedPath = normalizePath(relative(dir, resolve(dir, truthPath)))

      return normalizedPath.startsWith('.') ? normalizedPath : `./${normalizedPath}`
    }
  }

  return importer
}

export function transformCode(options: {
  filePath: string,
  content: string,
  aliases: Alias[],
  aliasesExclude: (string | RegExp)[],
  staticImport: boolean,
  clearPureImport: boolean,
  cleanVueFileName: boolean
}) {
  const s = new MagicString(options.content)
  const ast = ts.createSourceFile('a.ts', options.content, ts.ScriptTarget.Latest)

  const dir = dirname(options.filePath)

  const importMap = new Map<string, Set<string>>()
  const usedDefault = new Map<string, string>()
  const declareModules: string[] = []

  const toLibName = (origin: string) => {
    const name = transformAlias(origin, dir, options.aliases, options.aliasesExclude)

    return options.cleanVueFileName ? name.replace(/\.vue$/, '') : name
  }

  let indexCount = 0

  walkSourceFile(ast, (node, parent) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause) {
        options.clearPureImport && s.remove(node.pos, node.end)
      } else if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        (node.importClause.name ||
          (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)))
      ) {
        const libName = toLibName(node.moduleSpecifier.text)
        const importSet =
          importMap.get(libName) ?? importMap.set(libName, new Set<string>()).get(libName)!

        if (node.importClause.name && !usedDefault.has(libName)) {
          const usedType = node.importClause.name.escapedText as string

          usedDefault.set(libName, usedType)
          importSet.add(`default as ${usedType}`)
        }

        if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
          node.importClause.namedBindings.elements.forEach(element => {
            if (element.propertyName) {
              importSet.add(`${element.propertyName.escapedText} as ${element.name.escapedText}`)
            } else {
              importSet.add(element.name.escapedText as string)
            }
          })
        }

        s.remove(node.pos, node.end)
      }

      return false
    }

    if (
      ts.isImportTypeNode(node) &&
      node.qualifier &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isIdentifier(node.qualifier) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      const libName = toLibName(node.argument.literal.text)

      if (!options.staticImport) {
        s.update(node.argument.literal.pos, node.argument.literal.end, `'${libName}'`)

        return !!node.typeArguments
      }

      const importSet =
        importMap.get(libName) ?? importMap.set(libName, new Set<string>()).get(libName)!

      let usedType = node.qualifier.escapedText as string

      if (usedType === 'default') {
        usedType =
          usedDefault.get(libName) ??
          usedDefault.set(libName, `__DTS_DEFAULT_${indexCount++}__`).get(libName)!

        importSet.add(`default as ${usedType}`)
        s.update(node.qualifier.pos, node.qualifier.end, usedType)
      } else {
        importSet.add(usedType)
      }

      // s.update(node.pos, node.end, ` ${usedType}`)
      if (ts.isImportTypeNode(parent) && parent.typeArguments && parent.typeArguments[0] === node) {
        s.remove(node.pos, node.argument.end + 2)
      } else {
        s.update(node.pos, node.argument.end + 2, ' ')
      }

      return !!node.typeArguments
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      s.update(
        node.arguments[0].pos,
        node.arguments[0].end,
        `'${toLibName(node.arguments[0].text)}'`
      )

      return false
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      s.update(
        node.moduleSpecifier.pos,
        node.moduleSpecifier.end,
        ` '${toLibName(node.moduleSpecifier.text)}'`
      )

      return false
    }

    if (ts.isModuleDeclaration(node)) {
      if (
        node.modifiers?.[0] &&
        node.modifiers[0].kind === ts.SyntaxKind.DeclareKeyword &&
        node.body &&
        ts.isModuleBlock(node.body) &&
        !node.body.statements.some(
          s => ts.isExportAssignment(s) || ts.isExportDeclaration(s) || ts.isImportDeclaration(s)
        )
      ) {
        declareModules.push(s.slice(node.pos, node.end + 1))
      }

      return false
    }
  })

  let prependImports = ''

  importMap.forEach((importSet, libName) => {
    prependImports += `import { ${Array.from(importSet).join(', ')} } from '${libName}';\n`
  })

  s.prepend(prependImports)

  return {
    content: s.toString(),
    declareModules
  }
}

export function hasExportDefault(content: string) {
  const ast = ts.createSourceFile('a.ts', content, ts.ScriptTarget.Latest)

  let has = false

  walkSourceFile(ast, node => {
    if (ts.isExportAssignment(node)) {
      has = true
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (element.name.escapedText === 'default') {
          has = true
          break
        }
      }
    } else if ('modifiers' in node && Array.isArray(node.modifiers) && node.modifiers.length > 1) {
      for (let i = 0, len = node.modifiers.length; i < len; ++i) {
        if (
          node.modifiers[i].kind === ts.SyntaxKind.ExportKeyword &&
          node.modifiers[i + 1]?.kind === ts.SyntaxKind.DefaultKeyword
        ) {
          has = true
          break
        }
      }
    }

    return false
  })

  return has
}
