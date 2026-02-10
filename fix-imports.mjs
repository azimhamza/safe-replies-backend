import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';

async function* getFiles(dir) {
  const dirents = await readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else if (dirent.isFile() && res.endsWith('.js')) {
      yield res;
    }
  }
}

async function fixImports() {
  for await (const file of getFiles('./dist')) {
    let content = await readFile(file, 'utf-8');
    const fileDir = dirname(file);

    // Find all imports that need fixing
    const imports = content.matchAll(/from\s+['"](\..+?)(?<!\.js)['"]/g);
    const replacements = new Map();

    for (const match of imports) {
      const importPath = match[1];
      if (importPath.endsWith('.js') || !importPath.startsWith('.')) {
        continue;
      }

      const absolutePath = resolve(fileDir, importPath);

      try {
        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          replacements.set(match[0], `from '${importPath}/index.js'`);
        } else {
          replacements.set(match[0], `from '${importPath}.js'`);
        }
      } catch (e) {
        // File doesn't exist as-is, assume it's a .ts file that became .js
        replacements.set(match[0], `from '${importPath}.js'`);
      }
    }

    // Apply replacements
    for (const [oldImport, newImport] of replacements) {
      content = content.replaceAll(oldImport, newImport);
    }

    // Fix dynamic imports
    const dynamicImports = content.matchAll(/import\s*\(['"](\..+?)(?<!\.js)['"]\)/g);
    const dynamicReplacements = new Map();

    for (const match of dynamicImports) {
      const importPath = match[1];
      if (importPath.endsWith('.js') || !importPath.startsWith('.')) {
        continue;
      }

      const absolutePath = resolve(fileDir, importPath);

      try {
        const stats = await stat(absolutePath);
        if (stats.isDirectory()) {
          dynamicReplacements.set(match[0], `import('${importPath}/index.js')`);
        } else {
          dynamicReplacements.set(match[0], `import('${importPath}.js')`);
        }
      } catch (e) {
        dynamicReplacements.set(match[0], `import('${importPath}.js')`);
      }
    }

    for (const [oldImport, newImport] of dynamicReplacements) {
      content = content.replaceAll(oldImport, newImport);
    }

    await writeFile(file, content, 'utf-8');
  }
  console.log('✅ Fixed all import statements');
}

fixImports().catch(console.error);
