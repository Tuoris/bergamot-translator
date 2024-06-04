#!/usr/bin/env node

/**
 * A note upfront: the bergamot-translator API is pretty low level, and
 * embedding it successfully requires some knowledge about the WebWorkers and
 * WebAssembly APIs. This script tries to demonstrate the bergamot-translator
 * API with as little of that boiler plate code as possible.
 * See the wasm/test_page code for a fully fleshed out demo in a web context.
 */

// For node we use the fs module to read local files. In a web context you can
// use `fetch()` for everything.
const fs = require('fs');
const readline = require('node:readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

// Read wasm binary into a blob, which will be loaded by
// bergamot-translator-worker.js in a minute. In a web context, you'd be using
// `fetch(...).then(response => response.blob())` for this, but Node does not
// implement `fetch("file://...")` yet.
const wasmBinary = fs.readFileSync('./bergamot-translator-worker.wasm');

// Read wasm runtime code that bridges the bergmot-translator binary with JS.
const wasmRuntime = fs.readFileSync('./bergamot-translator-worker.js', { encoding: 'utf8' });

// Initialise the `Module` object. By adding methods and options to this, we can
// affect how bergamot-translator interacts with JavaScript. See 
// https://emscripten.org/docs/api_reference/module.html for all available
// options. It is important that this object is initialised in the same scope
// but before `bergamot-translation-worker.js` is executed. Once that script
// executes, it defines the exported methods as properties of this Module
// object.
global.Module = {
    wasmBinary,
    onRuntimeInitialized
};

// Execute bergamot-translation-worker.js in this scope. This will also,
// indirectly, call the onRuntimeInitialized function defined below and
// referenced in the `Module` object above.
eval.call(global, wasmRuntime);

/**
 * Called from inside the bergamot-translation-worker.js script once the wasm
 * module is initialized. At this point that `Module` object that was
 * initialised above will have all the classes defined in the
 * bergamot-translator API available on it.
 */
async function onRuntimeInitialized() {
    // Root url for our models for now.
    const root = './models/';

    const files = [
        // Neural network and weights:
        { url: `${root}uken/model.uken.intgemm8.bin`, alignment: 256 },

        // Lexical shortlist which is mainly a speed improvement method, not
        // strictly necessary:
        { url: `${root}uken/lex.uken.s2t.bin`, alignment: 64 },

        // Vocabulary, maps the input and output nodes of the neural network to
        // strings. Note: "deen" may look the wrong way around but vocab is the same
        // between de->en and en->de models.
        { url: `${root}uken/vocabsrc.uken.spm`, alignment: 64 },
        { url: `${root}uken/vocabtrg.uken.spm`, alignment: 64 },
    ];

    // Download model data and load it into aligned memory. AlignedMemory is a
    // necessary wrapper around allocated memory inside the WASM environment.
    // The value of `alignment` is specific for which part of the model we're
    // loading. See https://en.wikipedia.org/wiki/Data_structure_alignment for a
    // more general explanation.
    const [modelMem, shortlistMem, vocabMemScr, vocabMemTrg] = await Promise.all(files.map(async (file) => {
        const fileBlob = fs.readFileSync(file.url);
        const buffer = fileBlob;
        const bytes = new Int8Array(buffer);
        const memory = new Module.AlignedMemory(bytes.byteLength, file.alignment);
        memory.getByteArrayView().set(bytes);
        return memory;
    }));

    // Set up translation service. This service translates a batch of text per
    // call. The larger the batch, the faster the translation (in words per
    // second) happens, but the longer you have to wait for all of them to finish.
    // The constructor expects an object with options, but only one option is
    // currently supported: `cacheSize`. Setting this to `0` disables the
    // translation cache.
    // **Note**: cacheSize is the theoretical maximum number of sentences that
    // will be cached. In practise, about 1/3 of that will actually be used.
    // See https://github.com/XapaJIaMnu/translateLocally/pull/75
    const service = new Module.BlockingService({ cacheSize: 0 });

    // Put vocab into its own std::vector<AlignedMemory>. Most models for the
    // Bergamot project only have one vocabulary that is shared by both the input
    // and output side of the translator. But in theory, you could have one for
    // the input side and a different one for the output side. Hence: a list.
    const vocabs = new Module.AlignedMemoryList();
    vocabs.push_back(vocabMemScr);
    vocabs.push_back(vocabMemTrg);

    // Config yaml (split as array to allow for indentation without adding tabs
    // or spaces to the strings themselves.)
    // See https://marian-nmt.github.io/docs/cmd/marian-decoder/ for the meaning
    // of most of these options and what other options might be available.
    const config = [
        'beam-size: 1',
        'normalize: 1.0',
        'word-penalty: 0',
        'alignment: soft', // is necessary if you want to use HTML at any point
        'max-length-break: 128',
        'mini-batch-words: 1024',
        'workspace: 128',
        'max-length-factor: 2.0',
        'skip-cost: true',
        'gemm-precision: int8shiftAll', // is necessary for speed and compatibility with Mozilla's models.
    ].join('\n');

    // Construct std::vector<ResponseOptions>, one entry per input. Note that
    // all these three properties of your ResponseOptions object need to be
    // specified for each entry.
    // `qualityScores`: related to quality models not explained here. Set this
    //   to `false`.
    // `alignment`: computes alignment scores that maps parts of the input text
    //   to parts of the output text. There is currently no way to get these
    //   mappings out through the JavaScript API so I suggest you set this to
    //   `false` as well.
    // `html`: is the input HTML? If so, the HTML will be parsed and the markup
    //   will be copied back into the translated output. Note: HTML has to be
    //   valid HTML5, with proper closing tags and everything since the HTML
    //   parser built into bergamot-translator does no error correction. Output
    //   of e.g. `Element.innerHTML` meets this criteria.
    const options = new Module.VectorResponseOptions();
    options.push_back({ qualityScores: false, alignment: false, html: true });
    options.push_back({ qualityScores: false, alignment: false, html: false });

    // Setup up model with config yaml and AlignedMemory objects. Optionally a
    // quality estimation model can also be loaded but this is not demonstrated
    // here. Generally you don't need it, and many models don't include the data
    // file necessary to use it anyway.
    const model = new Module.TranslationModel(config, modelMem, shortlistMem, vocabs, /*qualityModel=*/ null);

    // Construct std::vector<std::string> inputs; This is our batch!


    // Translate our batch of 2 requests. Output will be another vector of type 
    // `std::vector<Response>`.
    let stop = false;
    while (!stop) {
        const modelInput = new Module.VectorString();
        const userInput = await new Promise(resolve => rl.question(">>> ", (answer) => resolve(answer)))
        if (!userInput || userInput === '/bye') {
            stop = true
            modelInput.delete();
            return
        }
        modelInput.push_back(userInput);

        const modelOutput = service.translate(model, modelInput, options);

        // Number of outputs is number of inputs.
        // console.assert(input.size() === output.size());

        for (let i = 0; i < modelOutput.size(); ++i) {
            // Get output from std::vector<Response>.
            const translation = modelOutput.get(i).getTranslatedText();

            // Print raw translation for inspection.
            console.log(translation)
        }

        modelInput.delete();
        modelOutput.delete();
    }

    // Clean-up: unlike the objects in JavaScript, the objects in the WASM
    // environment are not automatically cleaned up when they're no longer
    // referenced. That is why we manually have to call `delete()` on them
    // when we're done with them.
    options.delete();
}
