import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import inquirer from 'inquirer';
import path, { dirname, resolve } from 'path';
import { promisify } from 'util';
import { ConvertOptions } from './convert.js';
import { executeOscalCliCommand } from './env.js';
import { getServerClient } from './server.js';
import { Catalog, Profile } from './types.js';
import { detectOscalDocumentType, ExecutorOptions, resolveUri } from './utils.js';

const execAsync = promisify(exec);
export type OscalResolveOptions = {
  outputFormat: 'json'|'yaml'|'xml',
  quiet?:boolean
} 


export async function resolveProfileInline(
  document: Profile,
  options: ConvertOptions,
  executor: ExecutorOptions = 'oscal-server'
): Promise<string|Catalog> {
  const tempInputFile = path.resolve(process.cwd(), `oscal-cli-tmp-input-${randomUUID()}.json`);
  const tempOutputFile = path.resolve(process.cwd(), `oscal-cli-tmp-output-${randomUUID()}.${options.outputFormat}`);

  try {
    writeFileSync(tempInputFile, JSON.stringify(document));
    await resolveProfileDocument(tempInputFile, tempOutputFile, options, executor);
    const resolvedDocument = readFileSync(tempOutputFile, 'utf8');

    if (options.outputFormat === 'json') {
      return JSON.parse(resolvedDocument);
    }else{
      return resolvedDocument;
    }
  } finally {
    await Promise.all([
      unlinkSync(tempInputFile),
      unlinkSync(tempOutputFile)
    ]);
  }
}
export async function resolveProfile(
  documentPath: string,
  options: ConvertOptions,
  executor: ExecutorOptions = 'oscal-server'
): Promise<string|Catalog> {
  const tempOutputFile = path.resolve(process.cwd(), `oscal-cli-tmp-output-${randomUUID()}.${options.outputFormat}`);

  try {
    await resolveProfileDocument(documentPath, tempOutputFile, options, executor);
    const resolvedDocument = readFileSync(tempOutputFile, 'utf8');

    if (options.outputFormat === 'json') {
      return JSON.parse(resolvedDocument);
    }else{
      return resolvedDocument;
    }
  } finally {
    await Promise.all([
      unlinkSync(tempOutputFile)
    ]);
  }
}


export async function resolveProfileDocument(
  filePath: string,
  outputPath: string,
  options: ConvertOptions,
  executor: ExecutorOptions
): Promise<void> {
  if (executor === 'oscal-server') {
    try {
      await resolveFileWithServer(resolveUri(filePath),resolve(outputPath), options);
      return;
    } catch (error) {
      console.warn("Server resolution failed. Falling back to CLI resolve-profile.");
      executor = 'oscal-cli';
    }
  }

  if (executor === 'oscal-cli') {
    try {
      const args = [
        `--to=${options.outputFormat.toUpperCase()}`,
        filePath,
        outputPath,
        '--overwrite',
        '--show-stack-trace'
      ];
      const [result, errors] = await executeOscalCliCommand("resolve-profile", args);
      if (errors) {
        console.error('Errors during profile resolution:', errors);
        throw new Error('CLI resolution failed');
      }
      return;
    } catch (error) {
      console.error("Error resolving profile with CLI:", error);
      throw error;
    }
  }

  throw new Error(`Unsupported executor: ${executor}`);
}

async function resolveFileWithServer(
  inputFile: string,
  outputFile: string,
  options: ConvertOptions
): Promise<void> {
  try {
    const encodedArgs = `${inputFile.trim()}`;
    const outputDir = dirname(outputFile);
    mkdirSync(outputDir, { recursive: true });

    // Determine the Accept header based on options.outputFormat
    let acceptHeader = 'application/json'; // Default to JSON
    if (options.outputFormat) {
      switch (options.outputFormat.toLowerCase()) {
        case 'json':
          acceptHeader = 'text/json';
          break;
        case 'xml':
          acceptHeader = 'text/xml';
          break;
        case 'yaml':
          acceptHeader = 'text/yaml';
          break;
        // Add more cases as needed
        default:
          console.warn(`Unsupported output format: ${options.outputFormat}. Defaulting to JSON.`);
      }
    }
    const client = await getServerClient("http://localhost",8888,options.quiet);
    const { response, error,data } = await client.GET('/resolve', {
      params: { query: { document: encodedArgs,format:options.outputFormat } },
      parseAs: "blob" ,
      headers: { Accept: acceptHeader }
    });

    if (!response.ok) {
      console.error(error?.error);
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    if (!data) {
      throw new Error('No data received from the server');
    }

    // Convert blob to text
    const fileOutput = await data.text();

    writeFileSync(outputFile, fileOutput);
  } catch (error) {
    console.error('Error during validation:', error);
    throw error;
  }
}


export const resolveProfileCommand = async (fileArg, options: { file?: string; output?: string; server: boolean }) => {
  let { file, output, server } = options;
  file = fileArg || file;
  
  if (!file) {
    const answer = await inquirer.prompt<{ file: string }>([{
      type: 'input',
      name: 'file',
      message: 'Enter the path to the OSCAL profile document:',
      validate: (input: string) => input.trim() !== '' ? true : 'This field is required'
    }]);
    file = answer.file;
  }

  if (!output) {
    const answer = await inquirer.prompt<{ output: string }>([{
      type: 'input',
      name: 'output',
      message: 'Enter the path for the resolved output file:',
      validate: (input: string) => input.trim() !== '' ? true : 'This field is required'
    }]);
    output = answer.output;
  }

  console.log('Resolving OSCAL profile:', file);

  try {
    const [_, fileType] = await detectOscalDocumentType(file);

    // Determine output file type
    const outputFileType = path.extname(output).toLowerCase().slice(1);
    const validOutputTypes = ['json', 'xml', 'yaml'];
    const outputType = validOutputTypes.includes(outputFileType) ? outputFileType : fileType;

    const resolveOptions: ConvertOptions = { outputFormat: outputType as 'json' | 'yaml' | 'xml' };
    const executor: ExecutorOptions = server ? 'oscal-server' : 'oscal-cli';

    await resolveProfileDocument(file, output, resolveOptions, executor);

    console.log('Profile successfully resolved. Output saved to:', output);
  } catch (error) {
    console.error('Error resolving OSCAL profile:', error);
    process.exit(1);
  }
}