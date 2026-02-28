/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../common/common.css';
import '../common/shared.css';
import { main } from './app';

console.log('index.ts loaded, registering load event');
addEventListener('load', () => {
	console.log('Load event fired, calling main()');
	main();
});
